import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOBJ, parsePLY, parseIGESPoints, parsePointText, loadPoints } from '../js/io.js';
import { analyseMesh } from '../js/mesh.js';
import { luFactor, luSolve, bandFactor, bandSolve, reverseCuthillMcKee } from '../js/linalg.js';
import { FDM, objective } from '../js/fdm.js';
import { interpolateBSpline, evalBSpline, chainMembers } from '../js/splines.js';
import { sizeMembers, DEFAULT_MATERIAL } from '../js/sizing.js';
import { writeIGES } from '../js/iges.js';
import { runPipeline, exportIGES, exportCSV, exportJSON } from '../js/pipeline.js';
import { exampleMesh, exampleNetwork, supportsAt } from './fixtures.js';

const enc = (s) => new TextEncoder().encode(s).buffer;

test('OBJ: faces, polygons, negative indices and vertex colours', () => {
  const m = parseOBJ('v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 1 1 0 0.5 0.5 0.5\nv 0 1 0 0 0 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -4 -3 -2\n');
  assert.equal(m.positions.length, 12);
  assert.deepEqual(Array.from(m.triangles), [0, 1, 2, 0, 2, 3, 0, 1, 2]);
  assert.ok(Math.abs(m.scalars[0] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(m.scalars[2] - 0.5) < 1e-12);
  assert.equal(parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').scalars, null);
});

test('OBJ: 0-255 colours are normalised', () => {
  const m = parseOBJ('v 0 0 0 255 255 255\nv 1 0 0 0 0 0\nv 0 1 0 51 51 51\nf 1 2 3\n');
  assert.deepEqual(Array.from(m.scalars).map((v) => +v.toFixed(3)), [1, 0, 0.2]);
});

test('PLY: ascii and binary with uchar colours', () => {
  const header = (fmt) => `ply\nformat ${fmt} 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n`;
  const a = parsePLY(enc(header('ascii') + '0 0 0 255 255 255\n1 0 0 0 0 0\n0 1 0 102 102 102\n3 0 1 2\n'));
  assert.deepEqual(Array.from(a.triangles), [0, 1, 2]);
  assert.deepEqual(Array.from(a.scalars).map((v) => +v.toFixed(2)), [1, 0, 0.4]);
  const h = new TextEncoder().encode(header('binary_little_endian'));
  const buf = new ArrayBuffer(h.length + 3 * 15 + 13);
  new Uint8Array(buf).set(h);
  const dv = new DataView(buf); let o = h.length;
  for (const [x, y, z, c] of [[0, 0, 0, 255], [1, 0, 0, 0], [0, 1, 0, 102]]) {
    dv.setFloat32(o, x, true); dv.setFloat32(o + 4, y, true); dv.setFloat32(o + 8, z, true);
    dv.setUint8(o + 12, c); dv.setUint8(o + 13, c); dv.setUint8(o + 14, c); o += 15;
  }
  dv.setUint8(o, 3); dv.setInt32(o + 1, 0, true); dv.setInt32(o + 5, 1, true); dv.setInt32(o + 9, 2, true);
  const b = parsePLY(buf);
  assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
  assert.deepEqual(Array.from(b.scalars), Array.from(a.scalars));
});

test('point files: text, OBJ and an IGES round trip', () => {
  assert.deepEqual(Array.from(parsePointText('# c\n1,2,3\n4 5 6\n7;8;9\n')), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(loadPoints('s.obj', enc('v 1 2 3\nv 4 5 6\n'))), [1, 2, 3, 4, 5, 6]);
  const igs = writeIGES([{ type: 'point', xyz: [1.5, -2.25, 3e-7] }, { type: 'point', xyz: [3300.125, 0, 12] }]);
  assert.deepEqual(Array.from(parseIGESPoints(igs)), [1.5, -2.25, 3e-7, 3300.125, 0, 12]);
});

test('IGES: fixed 80-column records and consistent section counts', () => {
  const curve = interpolateBSpline(Float64Array.from([0, 0, 0, 1, 2, 0, 3, 3, 1, 6, 2, 2, 8, 0, 2]));
  const igs = writeIGES([{ type: 'curve', ...curve, level: 1, colour: 'red', label: 'D1.25' }, { type: 'point', xyz: [1, 2, 3], level: 3 }]);
  const lines = igs.trimEnd().split('\n');
  for (const l of lines) assert.equal(l.length, 80);
  const count = (c) => lines.filter((l) => l[72] === c).length;
  const term = lines.at(-1);
  assert.equal(term[72], 'T');
  assert.equal(+term.slice(1, 8), count('S'));
  assert.equal(+term.slice(9, 16), count('G'));
  assert.equal(+term.slice(17, 24), count('D'));
  assert.equal(+term.slice(25, 32), count('P'));
  assert.equal(count('D'), 4);
  // directory entry: type 126, parameter pointer 1, level 1; second line gives the P line count
  const d = lines.filter((l) => l[72] === 'D');
  assert.equal(+d[0].slice(0, 8), 126); assert.equal(+d[0].slice(8, 16), 1); assert.equal(+d[0].slice(32, 40), 1);
  const pFirst = lines.filter((l) => l[72] === 'P' && +l.slice(64, 72) === 1).length;
  assert.equal(+d[1].slice(24, 32), pFirst);
  assert.equal(+d[2].slice(8, 16), pFirst + 1);
  // parameter data: K=4, M=3, 9 knots, 5 weights, 15 coordinates, 2 range values, 3 normal components
  const pd = lines.filter((l) => l[72] === 'P' && +l.slice(64, 72) === 1).map((l) => l.slice(0, 64).trim()).join('');
  const tok = pd.replace(';', '').split(',');
  assert.equal(tok[0], '126'); assert.equal(tok[1], '4'); assert.equal(tok[2], '3');
  assert.equal(tok.length, 7 + 9 + 5 + 15 + 2 + 3);
});

test('dense LU with row pivoting', () => {
  const n = 6, A = new Float64Array(n * n), xTrue = [1, -2, 3, 0.5, -4, 2], b = new Float64Array(n);
  // small diagonal forces a row exchange at every step
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i * n + j] = i === j ? 1e-3 : Math.cos(1 + i * 3.1 + j * j * 1.7);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i] += A[i * n + j] * xTrue[j];
  const F = luFactor(Float64Array.from(A), n);
  assert.ok(Array.from(F.piv).some((p, k) => p !== k));
  const x = luSolve(F, b, 1);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(x[i] - xTrue[i]) < 1e-9);
});

test('dense and banded solvers agree', () => {
  const n = 40, adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (const j of [(i + 1) % n, (i + 7) % n]) { adj[i].push(j); adj[j].push(i); }
  const perm = reverseCuthillMcKee(adj), inv = new Int32Array(n);
  assert.deepEqual(Array.from(perm).sort((a, b) => a - b), [...Array(n).keys()]);
  perm.forEach((old, k) => { inv[old] = k; });
  let bw = 0;
  for (let i = 0; i < n; i++) for (const j of adj[i]) bw = Math.max(bw, Math.abs(inv[i] - inv[j]));
  const A = new Float64Array(n * n), Bd = new Float64Array(n * (bw + 1)), b = new Float64Array(n), b2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    A[inv[i] * n + inv[i]] = adj[i].length + 0.5; Bd[inv[i] * (bw + 1)] = adj[i].length + 0.5;
    for (const j of adj[i]) { A[inv[i] * n + inv[j]] = -1; if (inv[i] > inv[j]) Bd[inv[i] * (bw + 1) + inv[i] - inv[j]] = -1; }
    b[i] = Math.sin(i); b2[i] = Math.sin(i);
  }
  luSolve(luFactor(A, n), b, 1); bandSolve(bandFactor(Bd, n, bw), b2, 1);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(b[i] - b2[i]) < 1e-10);
});

test('FDM: a hanging chain of three bars is in equilibrium and symmetric', () => {
  // nodes 0,3 fixed at (0,0,0),(3,0,0); unit loads down at 1 and 2; q = 1
  const nodes = Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
  const fdm = new FDM(nodes, Uint32Array.from([0, 1, 1, 2, 2, 3]), Uint8Array.from([1, 0, 0, 1]), Float64Array.from([0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0]));
  const q = Float64Array.from([1, 1, 1]);
  assert.ok(fdm.solve(q));
  assert.ok(Math.abs(fdm.x[4] + 1) < 1e-12 && Math.abs(fdm.x[7] + 1) < 1e-12); // both sag by 1
  assert.ok(Math.abs(fdm.x[3] - 1) < 1e-12);
  const { worst, reactions } = fdm.residual(q);
  assert.ok(worst < 1e-12);
  assert.ok(Math.abs(reactions[1] - 1) < 1e-12 && Math.abs(reactions[10] - 1) < 1e-12); // supports push up
});

test('adjoint gradient matches finite differences (signed q, all objective terms)', () => {
  const { net } = exampleNetwork([[0.3, 0.2], [0.7, 0.2], [0.5, 0.8]], 25);
  const n = net.nodes.length / 3, m = net.edges.length / 2, h = 25;
  const X = Float64Array.from(net.nodes, (v) => v / h), P = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) P[3 * i + 1] = -1;
  const fdm = new FDM(X, net.edges, net.fixed, P);
  const opts = { normals: net.nodeNormals, wt: 0.1, lambda: 0.3, eps: 0.01, lpScale: 0.01, lmin: 0.9, beta: 5, pin: net.nodeBoundary, pinWeight: 2 };
  const q = new Float64Array(m);
  for (let e = 0; e < m; e++) q[e] = 1 + 0.5 * Math.sin(3 * e) + (e % 7 === 0 ? -0.6 : 0);
  const g = new Float64Array(m);
  const J0 = objective(fdm, q, opts, g).J;
  assert.ok(Number.isFinite(J0));
  for (const e of [0, 3, 7, 14, m - 1]) {
    const d = 1e-6, qp = Float64Array.from(q), qm = Float64Array.from(q);
    qp[e] += d; qm[e] -= d;
    const fd = (objective(fdm, qp, opts, null).J - objective(fdm, qm, opts, null).J) / (2 * d);
    assert.ok(Math.abs(fd - g[e]) < 1e-5 * Math.max(1, Math.abs(fd)), `edge ${e}: fd ${fd} vs adjoint ${g[e]}`);
  }
});

test('B-spline interpolation passes through its points', () => {
  const pts = Float64Array.from([0, 0, 0, 1, 2, 0, 3, 3, 1, 6, 2, 2, 8, 0, 2, 9, -1, 4]);
  const c = interpolateBSpline(pts);
  assert.equal(c.degree, 3);
  assert.equal(c.knots.length, 6 + 3 + 1);
  for (let i = 0; i < 6; i++) {
    const p = evalBSpline(c, c.params[i]);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - pts[3 * i + k]) < 1e-9);
  }
  assert.equal(interpolateBSpline(Float64Array.from([0, 0, 0, 1, 1, 1])).degree, 1);
});

test('chaining: a straight run is one curve and a branch starts another', () => {
  //  0 - 1 - 2 - 3 along x, plus 2 - 4 going up
  const x = Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
  const edges = Uint32Array.from([0, 1, 1, 2, 2, 3, 2, 4]);
  const chains = chainMembers(x, edges, new Uint8Array(4).fill(1), new Uint8Array(5));
  assert.equal(chains.length, 2);
  const long = chains.find((c) => c.nodes.length === 4);
  assert.ok(long && (long.nodes.join() === '0,1,2,3' || long.nodes.join() === '3,2,1,0'));
});

test('sizing: strength, buckling and minimum gauge', () => {
  const mat = { ...DEFAULT_MATERIAL };
  const s = sizeMembers(Float64Array.from([0.1, 120, -120]), Float64Array.from([10, 10, 30]), mat);
  assert.equal(s.diameter[0], mat.minDiameter); assert.equal(s.governs[0], 0);
  const sigma = mat.strength / mat.safety;
  assert.ok(Math.abs(s.diameter[1] - Math.sqrt((4 * 120) / (Math.PI * sigma))) < 1e-12); assert.equal(s.governs[1], 1);
  assert.equal(s.governs[2], 2);
  const d = s.diameter[2], Pcr = (Math.PI ** 2 * mat.modulus * (Math.PI * d ** 4 / 64)) / 30 ** 2;
  assert.ok(Math.abs(Pcr - 120 * mat.safety) < 1e-6);
});

test('example mesh analysis', () => {
  const { mesh, info } = exampleMesh();
  assert.equal(info.nv, 2755); assert.equal(info.nt, 5305); assert.equal(info.nonManifold, 0);
  assert.equal(info.upAxis, 1);
  assert.equal(mesh.scalars, null);
});

for (const mode of ['mixed', 'tension', 'compression']) {
  test(`pipeline on the example mesh (${mode}): equilibrium, load balance, exports`, () => {
    const { mesh, info } = exampleMesh();
    const sup = supportsAt(mesh, info, [[0.3, 0.15], [0.7, 0.15], [0.3, 0.5], [0.7, 0.5], [0.3, 0.85], [0.7, 0.85]]);
    const pts = new Float64Array(sup.length * 3);
    sup.forEach((v, i) => pts.set(mesh.positions.subarray(3 * v, 3 * v + 3), 3 * i));
    const r = runPipeline(mesh, pts, { spacing: 12, pressure: 10, mode, maxIter: 200 });
    const s = r.stats;
    assert.ok(s.exact);
    assert.ok(s.residual < 1e-6 * s.totalLoad, `residual ${s.residual}`);
    // vertical reactions balance the applied load
    let ry = 0, rx = 0, rz = 0;
    for (let i = 0; i < r.network.fixed.length; i++) if (r.network.fixed[i]) { rx += r.reactions[3 * i]; ry += r.reactions[3 * i + 1]; rz += r.reactions[3 * i + 2]; }
    assert.ok(Math.abs(ry - s.totalLoad) < 1e-6 * s.totalLoad, `reactions ${ry} vs load ${s.totalLoad}`);
    assert.ok(Math.abs(rx) < 1e-6 * s.totalLoad && Math.abs(rz) < 1e-6 * s.totalLoad, 'horizontal thrusts cancel overall');
    assert.ok(Math.abs(s.totalLoad - 0.01 * info.totalArea) < 1e-9 * s.totalLoad, 'total load = pressure x area');
    if (mode === 'tension') assert.ok(r.force.every((f) => f > 0));
    if (mode === 'compression') assert.ok(r.force.every((f) => f < 0));
    // every member belongs to exactly one curve
    const seen = new Uint8Array(s.members);
    for (const c of r.curves) for (const e of c.edges) seen[e]++;
    assert.ok(seen.every((v) => v === 1));
    assert.ok(r.diameter.every((d) => d >= 1));
    // every spline passes through the nodes of its chain
    for (const c of r.curves)
      for (let i = 0; i < c.points.length / 3; i++) {
        const p = evalBSpline(c.curve, c.curve.params[i]);
        assert.ok(Math.hypot(p[0] - c.points[3 * i], p[1] - c.points[3 * i + 1], p[2] - c.points[3 * i + 2]) < 1e-6);
      }
    const igs = exportIGES(r);
    assert.ok(igs.split('\n').filter(Boolean).every((l) => l.length === 80));
    assert.equal(exportCSV(r).trim().split('\n').length, r.curves.length + 1);
    assert.equal(JSON.parse(exportJSON(r)).members.length, s.members);
  });
}
