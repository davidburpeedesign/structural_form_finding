import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadMesh, loadPoints } from './io.js';
import { analyseMesh } from './mesh.js';
import { sampleBSpline } from './splines.js';
import { exportIGES, exportCSV, exportJSON } from './pipeline.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const state = { mesh: null, info: null, supports: [], result: null, picking: false, runId: 0, worker: null };

// ---------------------------------------------------------------- scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0); // the page's void and grid show through
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
camera.add(sun); sun.position.set(0.4, 0.8, 1); scene.add(camera);

const groups = { mesh: new THREE.Group(), supports: new THREE.Group(), rods: new THREE.Group(), secondary: new THREE.Group(), curves: new THREE.Group() };
Object.values(groups).forEach((g) => scene.add(g));
groups.curves.visible = false;
let needsRender = true;
const invalidate = () => { needsRender = true; };
controls.addEventListener('change', invalidate);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(canvas);
(function loop() {
  requestAnimationFrame(loop);
  if (controls.update() || needsRender) { needsRender = false; renderer.render(scene, camera); }
})();

function clearGroup(g) {
  for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
}

const downVector = () => {
  const v = $('down').value, k = 'xyz'.indexOf(v[1]);
  const d = [0, 0, 0]; d[k] = v[0] === '-' ? -1 : 1;
  return d;
};

function frameCamera() {
  const { info } = state;
  if (!info) return;
  const c = new THREE.Vector3((info.min[0] + info.max[0]) / 2, (info.min[1] + info.max[1]) / 2, (info.min[2] + info.max[2]) / 2);
  const d = downVector();
  const up = new THREE.Vector3(-d[0], -d[1], -d[2]);
  // look from an oblique direction from the side the load comes from
  const side = Math.abs(up.x) > 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const third = new THREE.Vector3().crossVectors(up, side);
  const dir = up.clone().multiplyScalar(0.75).addScaledVector(side, 0.45).addScaledVector(third, 0.8).normalize();
  camera.up.copy(up);
  camera.position.copy(c).addScaledVector(dir, info.diag * 1.9);
  camera.near = info.diag / 200; camera.far = info.diag * 50; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update();
  invalidate();
}

// Render palette: the brand's data scheme (imagery only).
const DATA = { violet: '#312f4a', maroonDeep: '#472b31', maroon: '#8d3e46', amber: '#dd7d56', blue: '#6b95c2' };
const RAMP = [DATA.violet, DATA.maroonDeep, DATA.maroon, DATA.amber].map((c) => new THREE.Color(c));
// load scalar -> pressure-map colour
function ramp(t, out) {
  const u = Math.min(0.9999, Math.max(0, t)) * (RAMP.length - 1), i = Math.floor(u);
  out.copy(RAMP[i]).lerp(RAMP[i + 1], u - i);
}

function rebuildMesh() {
  clearGroup(groups.mesh);
  const { mesh, info } = state;
  if (!mesh) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  const col = new Float32Array(info.nv * 3), c = new THREE.Color();
  for (let i = 0; i < info.nv; i++) { if (mesh.scalars) ramp(mesh.scalars[i], c); else c.set('#3a3a3a'); col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1, metalness: 0, transparent: true, opacity: state.result ? 0.4 : 0.92, depthWrite: !state.result }));
  m.name = 'surface';
  groups.mesh.add(m);
  // faint wireframe of the source triangulation
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: css('--mx-bone'), transparent: true, opacity: 0.07, depthWrite: false }));
  wire.raycast = () => {};
  groups.mesh.add(wire);
  invalidate();
}

function rebuildSupports() {
  clearGroup(groups.supports);
  if (!state.info) return;
  const r = state.info.diag * 0.01;
  const geo = new THREE.SphereGeometry(r, 20, 14);
  const mat = new THREE.MeshBasicMaterial({ color: css('--mx-white') });
  state.supports.forEach((p, i) => {
    const s = new THREE.Mesh(geo, mat);
    s.position.set(p[0], p[1], p[2]); s.userData.supportIndex = i;
    groups.supports.add(s);
  });
  invalidate();
}

function rodMesh(result, select, colourOf) {
  const { x, network: { edges }, diameter } = result;
  const idx = [];
  for (let e = 0; e < diameter.length; e++) if (select(e)) idx.push(e);
  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }), idx.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion(), s = new THREE.Vector3(), mtx = new THREE.Matrix4();
  idx.forEach((e, k) => {
    a.fromArray(x, 3 * edges[2 * e]); b.fromArray(x, 3 * edges[2 * e + 1]);
    dir.subVectors(b, a); const len = dir.length();
    mid.addVectors(a, b).multiplyScalar(0.5);
    q.setFromUnitVectors(yAxis, dir.normalize());
    s.set(diameter[e], len, diameter[e]);
    inst.setMatrixAt(k, mtx.compose(mid, q, s));
    inst.setColorAt(k, colourOf(e));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}

// ribs: boxes hanging below the surface, width in the surface, depth along the normal
function ribMesh(result, select, colourOf) {
  const { x, below, network: { edges }, width, depth } = result;
  const idx = [];
  for (let e = 0; e < depth.length; e++) if (select(e)) idx.push(e);
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }), idx.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), mid = new THREE.Vector3(), mtx = new THREE.Matrix4();
  idx.forEach((e, k) => {
    const i = edges[2 * e], j = edges[2 * e + 1];
    a.fromArray(x, 3 * i); b.fromArray(x, 3 * j);
    X.subVectors(b, a); const len = X.length(); X.divideScalar(len);
    Z.set(below[3 * i] + below[3 * j], below[3 * i + 1] + below[3 * j + 1], below[3 * i + 2] + below[3 * j + 2]);
    Z.addScaledVector(X, -Z.dot(X)).normalize();
    Y.crossVectors(Z, X);
    mid.addVectors(a, b).multiplyScalar(0.5).addScaledVector(Z, depth[e] / 2);
    mtx.makeBasis(X.clone().multiplyScalar(len), Y.clone().multiplyScalar(width[e]), Z.clone().multiplyScalar(depth[e])).setPosition(mid);
    inst.setMatrixAt(k, mtx);
    inst.setColorAt(k, colourOf(e));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}

function rebuildResult() {
  clearGroup(groups.rods); clearGroup(groups.secondary); clearGroup(groups.curves);
  const r = state.result;
  if (!r) return;
  const cT = new THREE.Color(DATA.amber), cC = new THREE.Color(DATA.blue), cS = new THREE.Color('#6f6e6b');
  const build = r.method === 'ribs' ? ribMesh : rodMesh;
  groups.rods.add(build(r, (e) => r.primary[e], (e) => (r.force[e] >= 0 ? cT : cC)));
  groups.secondary.add(build(r, (e) => !r.primary[e], () => cS));
  for (const c of r.curves) {
    const pts = sampleBSpline(c.curve, 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const colour = c.tier === 'secondary' ? cS : c.force >= 0 ? cT : cC;
    groups.curves.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour })));
    if (c.lowerCurve) {
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.BufferAttribute(sampleBSpline(c.lowerCurve, 8), 3));
      groups.curves.add(new THREE.Line(g2, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.45 })));
    }
  }
  invalidate();
}

function rebuildAll() { rebuildMesh(); rebuildSupports(); rebuildResult(); }

// ---------------------------------------------------------------- inputs
function setStatus(text) { $('status').textContent = text; }
function showWarnings(list, error) {
  const ul = $('warnings'); ul.replaceChildren();
  if (error) { const li = document.createElement('li'); li.className = 'error'; li.textContent = String(error).toLowerCase(); ul.append(li); }
  for (const w of list || []) { const li = document.createElement('li'); li.textContent = w; ul.append(li); }
}

function clearResult() {
  state.result = null;
  $('resultsSection').hidden = true; $('exportSection').hidden = true;
  rebuildResult(); rebuildMesh();
}

function updateInfo() {
  const { mesh, info, supports } = state;
  $('empty').hidden = !!mesh;
  $('runBtn').disabled = !(mesh && supports.length);
  if (!mesh) { $('readout').textContent = ''; $('geomInfo').textContent = 'no mesh loaded.'; $('loadInfo').textContent = ''; return; }
  const size = [0, 1, 2].map((k) => (info.max[k] - info.min[k]).toFixed(0)).join(' × ');
  $('geomInfo').textContent = `${info.nv} vertices / ${info.nt} faces / ${size} mm / ${supports.length} support${supports.length === 1 ? '' : 's'}.` +
    (mesh.scalars ? '' : ' no vertex colours: load scalar is 1.0 everywhere.');
  $('readout').textContent = `${state.name || 'mesh'}\nv.${info.nv} f.${info.nt}\n${size} mm`;
  let total = 0;
  for (let v = 0; v < info.nv; v++) total += info.area[v] * (mesh.scalars ? mesh.scalars[v] : 1);
  const P = total * (+$('pressure').value || 0) * 1e-3;
  $('loadInfo').textContent = `total load ${P.toFixed(P < 10 ? 2 : 1)} N over ${(info.totalArea / 100).toFixed(1)} cm².`;
}

function setMesh(mesh, name) {
  state.mesh = mesh;
  state.name = (name || 'mesh').toLowerCase();
  state.info = analyseMesh(mesh.positions, mesh.triangles);
  state.supports = [];
  $('supportName').textContent = 'none';
  $('down').value = '-' + 'xyz'[state.info.upAxis];
  clearResult(); rebuildSupports(); frameCamera(); updateInfo(); showWarnings([]); setStatus('');
}

async function readFile(input, fn) {
  const f = input.files[0];
  if (!f) return;
  try { fn(f.name, await f.arrayBuffer()); $(input.id.replace('File', 'Name')).textContent = f.name.toLowerCase(); }
  catch (err) { showWarnings([], err.message.toLowerCase()); }
  input.value = '';
}
$('meshFile').addEventListener('change', (ev) => readFile(ev.target, (name, buf) => setMesh(loadMesh(name, buf), name)));
$('supportFile').addEventListener('change', (ev) => readFile(ev.target, (name, buf) => {
  const pts = loadPoints(name, buf);
  state.supports = [];
  for (let i = 0; i < pts.length / 3; i++) state.supports.push([pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]]);
  clearResult(); rebuildSupports(); updateInfo();
}));
$('exampleBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('examples/load_mesh.obj');
    if (!res.ok) throw new Error('example mesh could not be fetched.');
    setMesh(loadMesh('load_mesh.obj', await res.arrayBuffer()), 'load_mesh.obj');
    $('meshName').textContent = 'load_mesh.obj';
  } catch (err) { showWarnings([], err.message); }
});
$('clearSupports').addEventListener('click', () => { state.supports = []; clearResult(); rebuildSupports(); updateInfo(); });
$('pickBtn').addEventListener('click', () => {
  state.picking = !state.picking;
  $('pickBtn').setAttribute('aria-pressed', String(state.picking));
  canvas.classList.toggle('picking', state.picking);
});
$('down').addEventListener('change', () => { frameCamera(); clearResult(); });
function syncMethod() {
  const m = $('method').value;
  for (const el of document.querySelectorAll('[data-m]')) el.hidden = el.dataset.m !== m;
}
$('method').addEventListener('change', () => { syncMethod(); clearResult(); });
syncMethod();
$('pressure').addEventListener('input', updateInfo);

// click to add a support on the surface, click an existing support to remove it
const ray = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener('pointerup', (ev) => {
  if (!state.picking || !state.mesh || !downAt) return;
  if (Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return; // it was an orbit drag
  const rect = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const hitS = ray.intersectObjects(groups.supports.children)[0];
  if (hitS) state.supports.splice(hitS.object.userData.supportIndex, 1);
  else {
    const hit = ray.intersectObjects(groups.mesh.children.filter((o) => o.isMesh))[0];
    if (!hit) return;
    state.supports.push([hit.point.x, hit.point.y, hit.point.z]);
  }
  clearResult(); rebuildSupports(); updateInfo();
});

for (const [id, g] of [['showMesh', 'mesh'], ['showRods', 'rods'], ['showSecondary', 'secondary'], ['showCurves', 'curves']])
  $(id).addEventListener('change', (ev) => { groups[g].visible = ev.target.checked; invalidate(); });

// ---------------------------------------------------------------- run
function readParams() {
  const v = (id) => +$(id).value;
  return {
    method: $('method').value, maxDepth: v('maxDepth'), maxAspect: v('maxAspect'),
    down: downVector(), pressure: v('pressure'), spacing: v('spacing'), mode: $('mode').value,
    lambda: Math.pow(10, v('lambda')), maxIter: v('iters'), threshold: v('threshold') / 100, maxTurn: v('maxTurn'),
    material: { strength: v('strength'), modulus: v('modulus'), density: v('density'), safety: v('safety'), minDiameter: v('minDia'), minOpening: v('minOpen') },
  };
}

function run() {
  if (!state.mesh || !state.supports.length) return;
  if (state.worker) state.worker.terminate();
  const worker = (state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  const id = ++state.runId;
  const t0 = performance.now();
  $('runBtn').disabled = true; $('progress').hidden = false; $('progress').value = 0;
  setStatus('generating...'); showWarnings([]);
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.id !== state.runId) return;
    if (msg.type === 'progress') { $('progress').value = msg.it / msg.total; setStatus(`generating... ${String(msg.it).padStart(String(msg.total).length, '0')} / ${msg.total}`); return; }
    $('progress').hidden = true; $('runBtn').disabled = false;
    worker.terminate(); state.worker = null;
    if (msg.type === 'error') { setStatus(''); showWarnings([], msg.message); return; }
    state.result = msg.result;
    setStatus(`done / ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    showWarnings(msg.result.warnings);
    showStats(msg.result);
    rebuildMesh(); rebuildResult();
  };
  worker.onerror = (ev) => { $('progress').hidden = true; $('runBtn').disabled = false; setStatus(''); showWarnings([], (ev.message || 'worker failed.').toLowerCase()); };
  worker.postMessage({ id, mesh: { positions: state.mesh.positions, triangles: state.mesh.triangles, scalars: state.mesh.scalars }, supports: Float64Array.from(state.supports.flat()), params: readParams() });
}
$('runBtn').addEventListener('click', run);

function showStats(r) {
  const s = r.stats, f = (v, d = 1) => v.toFixed(d);
  const rows = r.method === 'ribs' ? [
    ['network'],
    ['nodes / members', `${s.nodes} / ${s.members}`],
    ['shortest member', `${f(s.minLength)} mm`],
    ['deviation from surface', '0.00 mm'],
    ['response'],
    ['total load', `${f(s.totalLoad, 2)} N`],
    ['peak deflection', `${f(s.dispMax, 2)} mm`],
    ['peak stress / allowable', `${f(s.utilisationMax * 100, 0)} %`],
    ['sizing'],
    ['deepest rib', `${f(s.depthMax, 2)} mm`],
    ['widest rib', `${f(s.widthMax, 2)} mm`],
    ['at minimum section', `${s.nMin}`],
    ['sized by stress', `${s.nStrength}`],
    ['sized by buckling', `${s.nBuckling}`],
    ['at depth limit', `${s.nCapped}`],
    ['rib volume', `${f(s.volume / 1000, 2)} cm³`],
    ['rib mass', `${f(s.mass, 2)} g`],
    ['curves'],
    ['primary / secondary', `${s.curvesPrimary} / ${s.curvesSecondary}`],
  ] : [
    ['network'],
    ['nodes / members', `${s.nodes} / ${s.members}`],
    ['shortest member', `${f(s.minLength)} mm`],
    ['equilibrium residual', `${s.residual.toExponential(1)} N`],
    ['shape'],
    ['deviation from surface, rms', `${f(s.devRms, 2)} mm`],
    ['deviation from surface, max', `${f(s.devMax, 2)} mm`],
    ['drift along surface, rms / max', `${f(s.driftRms, 1)} / ${f(s.driftMax, 1)} mm`],
    ['forces'],
    ['total load', `${f(s.totalLoad, 2)} N`],
    ['peak tension', `${f(s.maxTension, 2)} N`],
    ['peak compression', `${f(s.maxCompression, 2)} N`],
    ['load path Σ|F|·L', `${f(s.loadPath / 1000, 2)} N·m`],
    ['sizing'],
    ['at minimum diameter', `${s.nMin}`],
    ['sized by strength', `${s.nStrength}`],
    ['sized by buckling', `${s.nBuckling}`],
    ['largest diameter', `${f(Math.max(...r.diameter), 2)} mm`],
    ['strut volume', `${f(s.volume / 1000, 2)} cm³`],
    ['strut mass', `${f(s.mass, 2)} g`],
    ['curves'],
    ['primary / secondary', `${s.curvesPrimary} / ${s.curvesSecondary}`],
  ];
  const table = $('stats'); table.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.length === 1) { tr.className = 'group'; const td = document.createElement('td'); td.colSpan = 2; td.textContent = row[0]; tr.append(td); }
    else for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; tr.append(td); }
    table.append(tr);
  }
  $('exportInfo').textContent = r.method === 'ribs'
    ? 'iges levels: 1 primary / 2 secondary curves on the surface, 3 supports, 4 / 5 the lower edge of each rib in the same order. loft a surface curve to its lower edge for the rib. labels: h = largest depth, w = largest width. csv lists depth at every node.'
    : 'iges levels: 1 primary / 2 secondary / 3 supports. red = tension, blue = compression. each curve is labelled with its largest diameter. csv rows follow the same order.';
  $('resultsSection').hidden = false; $('exportSection').hidden = false;
}

// ---------------------------------------------------------------- export
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const opt = () => ({ includeSecondary: $('incSecondary').checked });
$('expIges').addEventListener('click', () => download('form_finder.splines.igs', exportIGES(state.result, opt())));
$('expIgesPoly').addEventListener('click', () => download('form_finder.polylines.igs', exportIGES(state.result, { ...opt(), polyline: true })));
$('expCsv').addEventListener('click', () => download('form_finder.curves.csv', exportCSV(state.result, opt()), 'text/csv'));
$('expJson').addEventListener('click', () => download('form_finder.json', exportJSON(state.result), 'application/json'));

// hooks for automated checks
window.__app = { state, run, setSupports(list) { state.supports = list; clearResult(); rebuildSupports(); updateInfo(); } };
updateInfo(); resize();
