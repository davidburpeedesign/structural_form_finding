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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
camera.add(sun); sun.position.set(0.4, 0.8, 1); scene.add(camera);

const groups = { mesh: new THREE.Group(), supports: new THREE.Group(), rods: new THREE.Group(), secondary: new THREE.Group(), curves: new THREE.Group() };
Object.values(groups).forEach((g) => scene.add(g));
groups.curves.visible = false;
let needsRender = true;
const invalidate = () => { needsRender = true; };
controls.addEventListener('change', invalidate);

function applyTheme() {
  scene.background = new THREE.Color(css('--bg'));
  invalidate();
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); rebuildAll(); });

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

// load scalar -> colour ramp (light to dark, single hue)
function ramp(t, out) {
  const lo = new THREE.Color(css('--panel')).lerp(new THREE.Color('#d9c9a8'), 0.6), hi = new THREE.Color('#8a4b1f');
  out.copy(lo).lerp(hi, t);
}

function rebuildMesh() {
  clearGroup(groups.mesh);
  const { mesh, info } = state;
  if (!mesh) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  const col = new Float32Array(info.nv * 3), c = new THREE.Color();
  for (let i = 0; i < info.nv; i++) { ramp(mesh.scalars ? mesh.scalars[i] : 0.35, c); col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, transparent: true, opacity: state.result ? 0.45 : 1, depthWrite: !state.result }));
  m.name = 'surface';
  groups.mesh.add(m);
  invalidate();
}

function rebuildSupports() {
  clearGroup(groups.supports);
  if (!state.info) return;
  const r = state.info.diag * 0.012;
  const geo = new THREE.SphereGeometry(r, 20, 14);
  const mat = new THREE.MeshStandardMaterial({ color: css('--support'), roughness: 0.5 });
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

function rebuildResult() {
  clearGroup(groups.rods); clearGroup(groups.secondary); clearGroup(groups.curves);
  const r = state.result;
  if (!r) return;
  const cT = new THREE.Color(css('--tension')), cC = new THREE.Color(css('--compression')), cS = new THREE.Color(css('--secondary'));
  groups.rods.add(rodMesh(r, (e) => r.primary[e], (e) => (r.force[e] >= 0 ? cT : cC)));
  groups.secondary.add(rodMesh(r, (e) => !r.primary[e], () => cS));
  for (const c of r.curves) {
    const pts = sampleBSpline(c.curve, 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const colour = c.tier === 'secondary' ? cS : c.force >= 0 ? cT : cC;
    groups.curves.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour })));
  }
  invalidate();
}

function rebuildAll() { rebuildMesh(); rebuildSupports(); rebuildResult(); }

// ---------------------------------------------------------------- inputs
function setStatus(text) { $('status').textContent = text; }
function showWarnings(list, error) {
  const ul = $('warnings'); ul.replaceChildren();
  if (error) { const li = document.createElement('li'); li.className = 'error'; li.textContent = error; ul.append(li); }
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
  if (!mesh) { $('geomInfo').textContent = 'No mesh loaded.'; $('loadInfo').textContent = ''; return; }
  const size = [0, 1, 2].map((k) => (info.max[k] - info.min[k]).toFixed(0)).join(' × ');
  $('geomInfo').textContent = `${info.nv.toLocaleString()} vertices, ${info.nt.toLocaleString()} faces, ${size} mm. ` +
    `${supports.length} support${supports.length === 1 ? '' : 's'}.` + (mesh.scalars ? '' : ' No vertex colours found: load scalar is 1.0 everywhere.');
  let total = 0;
  for (let v = 0; v < info.nv; v++) total += info.area[v] * (mesh.scalars ? mesh.scalars[v] : 1);
  const P = total * (+$('pressure').value || 0) * 1e-3;
  $('loadInfo').textContent = `Total load ${P.toFixed(P < 10 ? 2 : 1)} N over ${(info.totalArea / 100).toFixed(1)} cm².`;
}

function setMesh(mesh) {
  state.mesh = mesh;
  state.info = analyseMesh(mesh.positions, mesh.triangles);
  state.supports = [];
  $('down').value = '-' + 'xyz'[state.info.upAxis];
  clearResult(); rebuildSupports(); frameCamera(); updateInfo(); showWarnings([]); setStatus('');
}

async function readFile(input, fn) {
  const f = input.files[0];
  if (!f) return;
  try { fn(f.name, await f.arrayBuffer()); }
  catch (err) { showWarnings([], err.message); }
  input.value = '';
}
$('meshFile').addEventListener('change', (ev) => readFile(ev.target, (name, buf) => setMesh(loadMesh(name, buf))));
$('supportFile').addEventListener('change', (ev) => readFile(ev.target, (name, buf) => {
  const pts = loadPoints(name, buf);
  state.supports = [];
  for (let i = 0; i < pts.length / 3; i++) state.supports.push([pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]]);
  clearResult(); rebuildSupports(); updateInfo();
}));
$('exampleBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('examples/load_mesh.obj');
    if (!res.ok) throw new Error('Could not fetch the example mesh.');
    setMesh(loadMesh('load_mesh.obj', await res.arrayBuffer()));
  } catch (err) { showWarnings([], err.message); }
});
$('clearSupports').addEventListener('click', () => { state.supports = []; clearResult(); rebuildSupports(); updateInfo(); });
$('pickBtn').addEventListener('click', () => {
  state.picking = !state.picking;
  $('pickBtn').setAttribute('aria-pressed', String(state.picking));
  canvas.classList.toggle('picking', state.picking);
});
$('down').addEventListener('change', () => { frameCamera(); clearResult(); });
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
    const hit = ray.intersectObjects(groups.mesh.children)[0];
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
  setStatus('Building network…'); showWarnings([]);
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.id !== state.runId) return;
    if (msg.type === 'progress') { $('progress').value = msg.it / msg.total; setStatus(`Optimising force densities… ${msg.it} / ${msg.total}`); return; }
    $('progress').hidden = true; $('runBtn').disabled = false;
    worker.terminate(); state.worker = null;
    if (msg.type === 'error') { setStatus(''); showWarnings([], msg.message); return; }
    state.result = msg.result;
    setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    showWarnings(msg.result.warnings);
    showStats(msg.result);
    rebuildMesh(); rebuildResult();
  };
  worker.onerror = (ev) => { $('progress').hidden = true; $('runBtn').disabled = false; setStatus(''); showWarnings([], ev.message || 'Worker failed.'); };
  worker.postMessage({ id, mesh: { positions: state.mesh.positions, triangles: state.mesh.triangles, scalars: state.mesh.scalars }, supports: Float64Array.from(state.supports.flat()), params: readParams() });
}
$('runBtn').addEventListener('click', run);

function showStats(r) {
  const s = r.stats, f = (v, d = 1) => v.toFixed(d);
  const rows = [
    ['Network'],
    ['Nodes / members', `${s.nodes} / ${s.members}`],
    ['Shortest member', `${f(s.minLength)} mm`],
    ['Equilibrium residual', `${s.residual.toExponential(1)} N`],
    ['Shape'],
    ['Deviation from surface, RMS', `${f(s.devRms, 2)} mm`],
    ['Deviation from surface, max', `${f(s.devMax, 2)} mm`],
    ['Drift along surface, RMS / max', `${f(s.driftRms, 1)} / ${f(s.driftMax, 1)} mm`],
    ['Forces'],
    ['Total load', `${f(s.totalLoad, 2)} N`],
    ['Peak tension', `${f(s.maxTension, 2)} N`],
    ['Peak compression', `${f(s.maxCompression, 2)} N`],
    ['Load path Σ|F|·L', `${f(s.loadPath / 1000, 2)} N·m`],
    ['Sizing'],
    ['At minimum diameter', `${s.nMin} members`],
    ['Sized by strength', `${s.nStrength} members`],
    ['Sized by buckling', `${s.nBuckling} members`],
    ['Largest diameter', `${f(Math.max(...r.diameter), 2)} mm`],
    ['Strut volume / mass', `${f(s.volume / 1000, 2)} cm³ / ${f(s.mass, 2)} g`],
    ['Curves'],
    ['Primary / secondary', `${s.curvesPrimary} / ${s.curvesSecondary}`],
  ];
  const table = $('stats'); table.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.length === 1) { tr.className = 'group'; const td = document.createElement('td'); td.colSpan = 2; td.textContent = row[0]; tr.append(td); }
    else for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; tr.append(td); }
    table.append(tr);
  }
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
$('expIges').addEventListener('click', () => download('form-finding-splines.igs', exportIGES(state.result, opt())));
$('expIgesPoly').addEventListener('click', () => download('form-finding-polylines.igs', exportIGES(state.result, { ...opt(), polyline: true })));
$('expCsv').addEventListener('click', () => download('form-finding-curves.csv', exportCSV(state.result, opt()), 'text/csv'));
$('expJson').addEventListener('click', () => download('form-finding.json', exportJSON(state.result), 'application/json'));

// hooks for automated checks
window.__app = { state, run, setSupports(list) { state.supports = list; clearResult(); rebuildSupports(); updateInfo(); } };
updateInfo(); resize();
