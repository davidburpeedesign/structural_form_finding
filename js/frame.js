// Linear 3D frame analysis of the rib network, and fully-stressed sizing of each rib.
//
// Every member is an Euler-Bernoulli beam with a rectangular section: width b lies in the design
// surface, depth h runs along the surface normal. Nodes stay exactly on the surface; what the
// network cannot carry axially it carries in bending, and h is sized for that.
//
// Local axes per member: x along the member, z the surface normal (made perpendicular to x),
// y = z x x. Bending "in depth" is about y and uses I_y = b h^3 / 12.

import { bandFactor, bandSolve, reverseCuthillMcKee } from './linalg.js';
import { buildShell, skinActions, skinStress } from './shell.js';

/** Torsion constant of a solid rectangle. */
function torsionJ(b, h) {
  const a = Math.max(b, h), c = Math.min(b, h);
  return a * c ** 3 * (1 / 3 - 0.21 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
}

export class Frame {
  /**
   * @param nodes   Float64Array(3n)
   * @param edges   Uint32Array(2m)
   * @param normals Float64Array(3n) depth direction at each node
   * @param fixed   Uint8Array(n)   1 = translations restrained (pinned support)
   * @param clampRotations restrain rotations at supports as well
   * @param tris    optional Uint32Array(3t): skin triangles sharing the same nodes
   * @param eccentric place each rib's centroid half its depth below the node (ribs hang under the surface)
   */
  constructor(nodes, edges, normals, fixed, clampRotations = false, tris = null, eccentric = false) {
    this.tris = tris; this.eccentric = eccentric; this.shell = null; this.thickness = null;
    this.nodes = nodes; this.edges = edges; this.fixed = fixed;
    const n = (this.n = nodes.length / 3), m = (this.m = edges.length / 2);
    const adjacency = Array.from({ length: n }, () => []);
    const pairs = [];
    for (let e = 0; e < m; e++) pairs.push([edges[2 * e], edges[2 * e + 1]]);
    if (tris) for (let t = 0; t < tris.length / 3; t++) for (let k = 0; k < 3; k++) pairs.push([tris[3 * t + k], tris[3 * t + (k + 1) % 3]]);
    for (const [a, b] of pairs) { adjacency[a].push(b); adjacency[b].push(a); }
    const perm = reverseCuthillMcKee(adjacency);
    this.order = new Int32Array(n);
    perm.forEach((old, k) => { this.order[old] = k; });
    let bwNodes = 0;
    for (const [a, b] of pairs) bwNodes = Math.max(bwNodes, Math.abs(this.order[a] - this.order[b]));
    this.ndof = 6 * n; this.bw = 6 * (bwNodes + 1) - 1;
    this.restrained = new Uint8Array(this.ndof);
    for (let i = 0; i < n; i++) if (fixed[i]) for (let k = 0; k < (clampRotations ? 6 : 3); k++) this.restrained[6 * this.order[i] + k] = 1;
    // member geometry: length and rotation matrix (rows = local x, y, z)
    this.length = new Float64Array(m); this.R = new Float64Array(9 * m);
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      const x = [nodes[3 * b] - nodes[3 * a], nodes[3 * b + 1] - nodes[3 * a + 1], nodes[3 * b + 2] - nodes[3 * a + 2]];
      const L = Math.hypot(...x); this.length[e] = L;
      for (let k = 0; k < 3; k++) x[k] /= L;
      let z = [normals[3 * a] + normals[3 * b], normals[3 * a + 1] + normals[3 * b + 1], normals[3 * a + 2] + normals[3 * b + 2]];
      let d = z[0] * x[0] + z[1] * x[1] + z[2] * x[2];
      z = z.map((v, k) => v - d * x[k]);
      let zl = Math.hypot(...z);
      if (zl < 1e-9) { // member parallel to the normal: any perpendicular will do
        z = Math.abs(x[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        d = z[0] * x[0] + z[1] * x[1] + z[2] * x[2];
        z = z.map((v, k) => v - d * x[k]); zl = Math.hypot(...z);
      }
      z = z.map((v) => v / zl);
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      this.R.set([...x, ...y, ...z], 9 * e);
    }
    this.u = new Float64Array(this.ndof);
  }

  /** Local 12x12 stiffness (row-major). */
  localK(e, b, h, E, G) {
    const L = this.length[e], A = b * h, Iy = (b * h ** 3) / 12, Iz = (h * b ** 3) / 12, J = torsionJ(b, h);
    const k = new Float64Array(144);
    const set = (i, j, v) => { k[i * 12 + j] = v; k[j * 12 + i] = v; };
    const ea = (E * A) / L, gj = (G * J) / L;
    set(0, 0, ea); set(0, 6, -ea); set(6, 6, ea);
    set(3, 3, gj); set(3, 9, -gj); set(9, 9, gj);
    const z1 = (12 * E * Iz) / L ** 3, z2 = (6 * E * Iz) / L ** 2, z3 = (4 * E * Iz) / L, z4 = (2 * E * Iz) / L;
    set(1, 1, z1); set(1, 5, z2); set(1, 7, -z1); set(1, 11, z2);
    set(5, 5, z3); set(5, 7, -z2); set(5, 11, z4);
    set(7, 7, z1); set(7, 11, -z2); set(11, 11, z3);
    const y1 = (12 * E * Iy) / L ** 3, y2 = (6 * E * Iy) / L ** 2, y3 = (4 * E * Iy) / L, y4 = (2 * E * Iy) / L;
    set(2, 2, y1); set(2, 4, -y2); set(2, 8, -y1); set(2, 10, -y2);
    set(4, 4, y3); set(4, 8, y2); set(4, 10, y4);
    set(8, 8, y1); set(8, 10, y2); set(10, 10, y3);
    return k;
  }

  /**
   * Solve K u = f for the given sections.
   * @returns member end actions: N (tension +), My, Mz (largest magnitude of the two ends), and u.
   */
  solve(width, depth, loads, E, nu = 0.35) {
    const { n, m, edges, order, ndof, bw, R, restrained } = this;
    const G = E / (2 * (1 + nu)), w = bw + 1;
    const K = new Float64Array(ndof * w), f = new Float64Array(ndof);
    const kg = new Float64Array(144), tmp = new Float64Array(144);
    const dofs = new Int32Array(12);
    for (let e = 0; e < m; e++) {
      const kl = this.localK(e, width[e], depth[e], E, G);
      this.rotate(e, kl, tmp, kg);
      if (this.eccentric) this.offset(e, depth[e] / 2, kg, tmp);
      const a = order[edges[2 * e]], b = order[edges[2 * e + 1]];
      for (let k = 0; k < 6; k++) { dofs[k] = 6 * a + k; dofs[6 + k] = 6 * b + k; }
      for (let i = 0; i < 12; i++) {
        if (restrained[dofs[i]]) continue;
        for (let j = 0; j < 12; j++) {
          if (restrained[dofs[j]] || dofs[i] < dofs[j]) continue;
          K[dofs[i] * w + (dofs[i] - dofs[j])] += kg[i * 12 + j];
        }
      }
    }
    if (this.tris && this.thickness) {
      if (!this.shell || this.shellE !== E) { this.shell = buildShell(this.nodes, this.tris, E, nu); this.shellE = E; }
      const { Km, Kb } = this.shell, tr = this.tris, d18 = new Int32Array(18);
      for (let t = 0; t < tr.length / 3; t++) {
        const th = this.thickness[t];
        if (!(th > 0)) continue;
        for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) d18[6 * i + k] = 6 * order[tr[3 * t + i]] + k;
        const t3 = th * th * th, o = 324 * t;
        for (let i = 0; i < 18; i++) {
          if (restrained[d18[i]]) continue;
          for (let j = 0; j < 18; j++) {
            if (restrained[d18[j]] || d18[i] < d18[j]) continue;
            K[d18[i] * w + (d18[i] - d18[j])] += th * Km[o + i * 18 + j] + t3 * Kb[o + i * 18 + j];
          }
        }
      }
    }
    let dmax = 0;
    for (let i = 0; i < ndof; i++) dmax = Math.max(dmax, K[i * w]);
    for (let i = 0; i < n; i++) {
      const o = 6 * order[i];
      for (let k = 0; k < 3; k++) { f[o + k] = loads[3 * i + k]; }
      // a whisper of rotational stiffness guards against a free spin about a lone straight member
      for (let k = 3; k < 6; k++) K[(o + k) * w] += 1e-10 * dmax;
    }
    for (let i = 0; i < ndof; i++) if (restrained[i]) { K[i * w] = 1; f[i] = 0; }
    const F = bandFactor(K, ndof, bw);
    if (!(F.minPivot > 0)) throw new Error('frame is unstable: at least three supports that are not in one line are needed.');
    bandSolve(F, f, 1);
    this.u = f;
    const N = new Float64Array(m), My = new Float64Array(m), Mz = new Float64Array(m);
    const ug = new Float64Array(12), ul = new Float64Array(12);
    for (let e = 0; e < m; e++) {
      const a = order[edges[2 * e]], b = order[edges[2 * e + 1]];
      for (let k = 0; k < 6; k++) { ug[k] = f[6 * a + k]; ug[6 + k] = f[6 * b + k]; }
      if (this.eccentric) {
        // centroid displacement = node displacement + rotation x offset
        const r = depth[e] / 2, rx = R[9 * e + 6] * r, ry = R[9 * e + 7] * r, rz = R[9 * e + 8] * r;
        for (const o of [0, 6]) {
          const tx = ug[o + 3], ty = ug[o + 4], tz = ug[o + 5];
          ug[o] += ty * rz - tz * ry; ug[o + 1] += tz * rx - tx * rz; ug[o + 2] += tx * ry - ty * rx;
        }
      }
      for (let blk = 0; blk < 4; blk++)
        for (let r = 0; r < 3; r++) {
          let s = 0;
          for (let c = 0; c < 3; c++) s += R[9 * e + 3 * r + c] * ug[3 * blk + c];
          ul[3 * blk + r] = s;
        }
      const kl = this.localK(e, width[e], depth[e], E, G);
      const fl = (i) => { let s = 0; for (let j = 0; j < 12; j++) s += kl[i * 12 + j] * ul[j]; return s; };
      N[e] = fl(6);
      My[e] = Math.max(Math.abs(fl(4)), Math.abs(fl(10)));
      Mz[e] = Math.max(Math.abs(fl(5)), Math.abs(fl(11)));
    }
    return { N, My, Mz };
  }

  /** Skin membrane forces and moments per triangle for the current solution. */
  skinState(utilisationOf) {
    const tr = this.tris, nt = tr.length / 3, u18 = new Float64Array(18), order = this.order;
    const N = new Float64Array(3 * nt), M = new Float64Array(3 * nt), n3 = [0, 0, 0], m3 = [0, 0, 0];
    for (let t = 0; t < nt; t++) {
      const th = this.thickness[t];
      if (!(th > 0)) continue;
      for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) u18[6 * i + k] = this.u[6 * order[tr[3 * t + i]] + k];
      skinActions(this.shell, t, u18, th, n3, m3);
      N.set(n3, 3 * t); M.set(m3, 3 * t);
    }
    return { N, M };
  }

  /** Move a member's stiffness from its centroid to its nodes: kg <- E^T kg E, centroid = node + r z. */
  offset(e, r, kg, tmp) {
    const R = this.R, rx = R[9 * e + 6] * r, ry = R[9 * e + 7] * r, rz = R[9 * e + 8] * r;
    // u_c = u + theta x r  ->  columns of -[r]x couple translations to rotations
    const X = [0, rz, -ry, -rz, 0, rx, ry, -rx, 0]; // (theta x r) as a matrix acting on theta
    // tmp = kg E   (column operation: rot columns += trans columns * X)
    tmp.set(kg);
    for (let i = 0; i < 12; i++)
      for (const o of [0, 6])
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = 0; k < 3; k++) s += kg[i * 12 + o + k] * X[3 * k + c];
          tmp[i * 12 + o + 3 + c] += s;
        }
    // kg = E^T tmp  (row operation)
    kg.set(tmp);
    for (let j = 0; j < 12; j++)
      for (const o of [0, 6])
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = 0; k < 3; k++) s += X[3 * k + c] * tmp[(o + k) * 12 + j];
          kg[(o + 3 + c) * 12 + j] += s;
        }
  }

  /** kg = T^T kl T with T = diag(R, R, R, R). */
  rotate(e, kl, tmp, kg) {
    const R = this.R, o = 9 * e;
    // tmp = kl T
    for (let i = 0; i < 12; i++)
      for (let blk = 0; blk < 4; blk++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let r = 0; r < 3; r++) s += kl[i * 12 + 3 * blk + r] * R[o + 3 * r + c];
          tmp[i * 12 + 3 * blk + c] = s;
        }
    // kg = T^T tmp
    for (let blk = 0; blk < 4; blk++)
      for (let c = 0; c < 3; c++)
        for (let j = 0; j < 12; j++) {
          let s = 0;
          for (let r = 0; r < 3; r++) s += R[o + 3 * r + c] * tmp[(3 * blk + r) * 12 + j];
          kg[(3 * blk + c) * 12 + j] = s;
        }
  }

  /** Displacement vector of node i (original numbering). */
  displacement(i) { const o = 6 * this.order[i]; return [this.u[o], this.u[o + 1], this.u[o + 2]]; }
}

/** Combined axial + biaxial bending stress at the extreme fibre of a b x h rectangle. */
export const ribStress = (N, My, Mz, b, h) => Math.abs(N) / (b * h) + (6 * My) / (b * h * h) + (6 * Mz) / (h * b * b);

/**
 * Smallest section for the given actions.
 * Depth grows first (it is the efficient direction for bending), with width following at
 * depth / maxAspect so ribs do not become unprintably thin blades. If depth hits its cap the
 * width grows instead. Compression members are also checked for Euler buckling about the
 * weak axis over their own length.
 * governs: 0 minimum section, 1 stress, 2 buckling, 3 depth cap reached
 */
export function sizeSection(N, My, Mz, L, lim) {
  const { sigma, minWidth, minDepth, maxDepth, maxAspect, E, safety } = lim;
  const bOf = (h) => Math.max(minWidth, h / maxAspect);
  let h = minDepth, b = bOf(h), governs = 0;
  if (ribStress(N, My, Mz, b, h) > sigma) {
    governs = 1;
    if (ribStress(N, My, Mz, bOf(maxDepth), maxDepth) <= sigma) {
      let lo = minDepth, hi = maxDepth;
      for (let it = 0; it < 40; it++) { const mid = 0.5 * (lo + hi); if (ribStress(N, My, Mz, bOf(mid), mid) > sigma) lo = mid; else hi = mid; }
      h = hi; b = bOf(h);
    } else {
      governs = 3; h = maxDepth;
      let lo = bOf(h), hi = lo;
      while (ribStress(N, My, Mz, hi, h) > sigma && hi < 1e4) hi *= 2;
      for (let it = 0; it < 40; it++) { const mid = 0.5 * (lo + hi); if (ribStress(N, My, Mz, mid, h) > sigma) lo = mid; else hi = mid; }
      b = hi;
    }
  }
  if (N < 0) {
    // P_cr = pi^2 E I_min / L^2 >= safety |N|
    const need = (safety * -N * L * L) / (Math.PI ** 2 * E);
    const Imin = () => (Math.max(b, h) * Math.min(b, h) ** 3) / 12;
    if (Imin() < need) {
      governs = 2;
      b = Math.max(b, Math.cbrt((12 * need) / h));
      if (Imin() < need) b = Math.max(b, (12 * need) / h ** 3); // width has overtaken depth
    }
  }
  return { b, h, governs };
}

/** Smallest skin thickness in [tMin, tMax] that keeps von Mises stress within sigma for fixed N, M. */
export function sizeSkin(N, M, sigma, tMin, tMax) {
  if (skinStress(N, M, tMin) <= sigma) return tMin;
  if (skinStress(N, M, tMax) > sigma) return tMax;
  let lo = tMin, hi = tMax;
  for (let it = 0; it < 30; it++) { const mid = 0.5 * (lo + hi); if (skinStress(N, M, mid) > sigma) lo = mid; else hi = mid; }
  return hi;
}

/**
 * Fully-stressed design of ribs and, optionally, skin: analyse, resize every element for its own
 * actions, repeat. Forces redistribute as sections change, so the loop is damped.
 *
 * skin.mode  'off'  ribs only
 *            'full' skin everywhere, thickened where its stress asks
 *            'auto' starts full, then removes skin where it is doing little (stress below
 *                   skin.keep x allowable at minimum thickness), a few elements per round, and
 *                   re-sizes after each round (evolutionary structural optimisation)
 */
export function sizeRibs(frame, loads, lim, { maxIter = 30, tol = 0.01, onIter = null, skin = null } = {}) {
  const m = frame.m;
  // Size against 90 % of the allowable. Forces shift a little every time sections change, and
  // some members are strained by their neighbours' deflection rather than by load (deepening
  // those raises their stress), so aiming exactly at the limit leaves a few members just over it.
  const sigmaLimit = lim.sigma;
  lim = { ...lim, sigma: 0.9 * lim.sigma };
  const width = new Float64Array(m).fill(Math.max(lim.minWidth, lim.minDepth / lim.maxAspect)), depth = new Float64Array(m).fill(lim.minDepth);
  const governs = new Uint8Array(m);
  const hasSkin = !!(skin && skin.mode !== 'off' && frame.tris);
  const nt = hasSkin ? frame.tris.length / 3 : 0;
  const thickness = hasSkin ? new Float64Array(nt).fill(skin.tMin) : null;
  frame.thickness = thickness;
  const removal = hasSkin && skin.mode === 'auto' ? 12 : 0;
  const closing = 30;
  const total = maxIter + removal * 3 + closing;
  let act = null, sk = null, iterations = 0;
  const tick = () => { iterations++; return !(onIter && onIter(Math.min(iterations, total), total) === false); };
  const analyse = () => { act = frame.solve(width, depth, loads, lim.E); if (hasSkin) sk = frame.skinState(); };
  const skinU = (t, th) => skinStress(sk.N.subarray(3 * t, 3 * t + 3), sk.M.subarray(3 * t, 3 * t + 3), th);
  const resize = (growOnly) => {
    let change = 0, grew = false;
    for (let e = 0; e < m; e++) {
      const s = sizeSection(act.N[e], act.My[e], act.Mz[e], frame.length[e], lim);
      let hn, bn;
      if (growOnly) { hn = Math.max(depth[e], s.h); bn = Math.max(width[e], s.b); if (hn > depth[e] * 1.002 || bn > width[e] * 1.002) { grew = true; governs[e] = s.governs; } }
      else { hn = 0.5 * (depth[e] + s.h); bn = 0.5 * (width[e] + s.b); governs[e] = s.governs; }
      change = Math.max(change, Math.abs(hn - depth[e]) / depth[e], Math.abs(bn - width[e]) / width[e]);
      depth[e] = hn; width[e] = bn;
    }
    for (let t = 0; t < nt; t++) {
      if (!(thickness[t] > 0)) continue;
      const need = sizeSkin(sk.N.subarray(3 * t, 3 * t + 3), sk.M.subarray(3 * t, 3 * t + 3), lim.sigma, skin.tMin, skin.tMax);
      const tn = growOnly ? Math.max(thickness[t], need) : 0.5 * (thickness[t] + need);
      if (growOnly && tn > thickness[t] * 1.002) grew = true;
      change = Math.max(change, Math.abs(tn - thickness[t]) / thickness[t]);
      thickness[t] = tn;
    }
    return growOnly ? grew : change;
  };

  for (let it = 0; it < maxIter; it++) {
    analyse();
    const change = resize(false);
    if (!tick() || change < tol) break;
  }
  // skin removal rounds with a rising rejection threshold
  for (let round = 1; round <= removal; round++) {
    analyse();
    const cut = (skin.keep * round) / removal;
    let removed = 0;
    for (let t = 0; t < nt; t++) if (thickness[t] > 0 && thickness[t] <= skin.tMin * 1.05 && skinU(t, thickness[t]) < cut * sigmaLimit) { thickness[t] = 0; removed++; }
    if (!removed && round > 1) { tick(); continue; }
    for (let k = 0; k < 3; k++) { analyse(); resize(false); if (!tick()) break; }
  }
  // Closing passes: sections may only grow, so the result settles on the safe side.
  analyse();
  for (let pass = 0; pass < closing; pass++) {
    const grew = resize(true);
    analyse(); tick();
    if (!grew) break;
  }
  const utilisation = new Float64Array(m);
  let uMax = 0;
  for (let e = 0; e < m; e++) { utilisation[e] = ribStress(act.N[e], act.My[e], act.Mz[e], width[e], depth[e]) / sigmaLimit; uMax = Math.max(uMax, utilisation[e]); }
  let skinUtil = null, skinUMax = 0;
  if (hasSkin) {
    skinUtil = new Float64Array(nt);
    for (let t = 0; t < nt; t++) if (thickness[t] > 0) { skinUtil[t] = skinU(t, thickness[t]) / sigmaLimit; skinUMax = Math.max(skinUMax, skinUtil[t]); }
  }
  return { width, depth, governs, utilisation, uMax, iterations, thickness, skinUtil, skinUMax, ...act };
}
