// End-to-end run: mesh + supports + parameters -> equilibrium network, member sizes, curves.
// Pure computation, no DOM: used by the web worker and by the tests.

import { analyseMesh, snapToVertices } from './mesh.js';
import { buildNetwork } from './network.js';
import { formFind } from './formfind.js';
import { sizeMembers, DEFAULT_MATERIAL } from './sizing.js';
import { extractSplines, interpolateBSpline } from './splines.js';
import { writeIGES } from './iges.js';
import { Frame, sizeRibs } from './frame.js';

export const DEFAULTS = {
  method: 'ribs',       // 'ribs': network fixed on the surface, sized in bending. 'funicular': free-form force density
  maxDepth: 20,         // mm, deepest rib allowed below the surface
  skin: 'off',          // 'off' | 'full' | 'auto' (skin only where it is doing work)
  skinMin: 1.0,         // mm, thinnest printable wall
  skinMax: 4.0,         // mm
  skinKeep: 0.25,       // auto: keep skin where its stress is at least this share of allowable
  sizingIter: 40,       // resize-and-reanalyse passes for rib sizing
  maxAspect: 6,         // largest depth / width ratio of a rib
  down: [0, -1, 0],
  pressure: 1.0,        // kPa applied where the load scalar is 1.0
  spacing: 8,           // mm, target node spacing of the network
  mode: 'mixed',
  lambda: 0.1,          // weight of load path (material) against fidelity to the surface
  slide: 0.1,           // how strongly nodes are held against sliding along the surface (0..1)
  maxIter: 600,
  threshold: 0.15,      // members below this fraction of the peak force are "secondary"
  maxTurn: 50,          // degrees a curve may turn at a node before it is split
  material: DEFAULT_MATERIAL,
};

export function runPipeline(mesh, supportPoints, userParams = {}, onProgress = () => true) {
  const params = { ...DEFAULTS, ...userParams, material: { ...DEFAULT_MATERIAL, ...(userParams.material || {}) } };
  const warnings = [];
  const info = analyseMesh(mesh.positions, mesh.triangles);
  if (info.nonManifold) warnings.push(`${info.nonManifold} non-manifold edges in the mesh. results near them may be unreliable.`);
  if (!mesh.scalars) warnings.push('mesh has no vertex colours. load scalar is 1.0 everywhere.');

  const pressure = params.pressure * 1e-3; // kPa -> N/mm2
  const vertexLoad = new Float64Array(info.nv);
  for (let v = 0; v < info.nv; v++) vertexLoad[v] = pressure * info.area[v] * (mesh.scalars ? mesh.scalars[v] : 1);

  const snap = snapToVertices(mesh.positions, supportPoints);
  const net = buildNetwork(mesh, info, vertexLoad, snap.index, params.spacing);
  if (net.nSupports < snap.index.length) warnings.push(`${snap.index.length - net.nSupports} support point(s) coincide with another support and were merged.`);
  // Supports keep their true position even when they sit off the surface; the members meeting
  // there then form a fan from the surface to the support.
  const usedVert = new Map();
  let offMax = 0;
  for (let s = 0; s < snap.index.length; s++) {
    if (usedVert.has(snap.index[s])) continue;
    const node = usedVert.size;
    usedVert.set(snap.index[s], node);
    net.nodes.set(supportPoints.subarray(3 * s, 3 * s + 3), 3 * node);
    offMax = Math.max(offMax, snap.dist[s]);
  }
  if (offMax > 0.5 * params.spacing) warnings.push(`a support lies ${offMax.toFixed(1)} mm off the surface. it is joined to the nearest part of the network.`);
  if (net.unassignedLoad > 0) warnings.push('part of the mesh is not connected to any support and carries no members.');
  if (net.nSupports < 3) warnings.push('fewer than three supports. the result balances this load only and has no stability against any other.');
  const m = net.edges.length / 2, n = net.nodes.length / 3;
  if (n >= 1200) warnings.push('node limit reached (1200). the network is coarser than the requested spacing in places.');

  if (params.method !== 'funicular') return runRibs(mesh, info, net, params, warnings, onProgress);

  // members shorter than this cannot be printed with a clear opening between their end nodes
  const minLength = Math.min(0.6 * params.spacing, params.material.minOpening + params.material.minDiameter);
  const ff = formFind(net, { ...params, minLength }, onProgress);
  const sizing = sizeMembers(ff.force, ff.length, params.material);
  const sp = extractSplines(ff.x, net.edges, net.fixed, ff.force, sizing.diameter, ff.length, params.threshold, params.maxTurn);

  // printability checks against the supplier's lattice rules
  let lMin = Infinity, tight = 0;
  for (let e = 0; e < m; e++) {
    lMin = Math.min(lMin, ff.length[e]);
    if (ff.length[e] - sizing.diameter[e] < params.material.minOpening) tight++;
  }
  if (tight) warnings.push(`${tight} member(s) are shorter than the minimum opening (${params.material.minOpening} mm) plus their own diameter. a larger node spacing clears this.`);
  if (ff.stats.devMax > 2 * params.spacing) warnings.push(`the equilibrium shape leaves the surface by up to ${ff.stats.devMax.toFixed(1)} mm. this surface is not close to funicular for these supports and this load direction.`);

  const signs = { tension: 0, compression: 0 };
  for (let e = 0; e < m; e++) if (Math.abs(ff.force[e]) >= params.threshold * sp.fmax) signs[ff.force[e] > 0 ? 'tension' : 'compression']++;

  return {
    method: 'funicular', params, warnings,
    network: { nodes: net.nodes, edges: net.edges, fixed: net.fixed, nodeLoad: net.nodeLoad, nSupports: net.nSupports },
    x: ff.x, force: ff.force, length: ff.length, deviation: ff.deviation, reactions: ff.reactions,
    diameter: sizing.diameter, governs: sizing.governs, primary: sp.primary,
    curves: sp.curves,
    stats: {
      ...ff.stats, nodes: n, members: m, minLength: lMin,
      volume: sizing.volume, mass: sizing.mass, maxTension: sizing.maxTension, maxCompression: sizing.maxCompression,
      nMin: sizing.nMin, nStrength: sizing.nStrength, nBuckling: sizing.nBuckling,
      primaryMembers: signs.tension + signs.compression, primaryTension: signs.tension, primaryCompression: signs.compression,
      curvesPrimary: sp.curves.filter((c) => c.tier === 'primary').length, curvesSecondary: sp.curves.filter((c) => c.tier === 'secondary').length,
      meshArea: info.totalArea,
    },
  };
}

/**
 * Ribs on the surface. Nodes stay where they were sampled, so the network is coincident with the
 * design surface; each member is a rectangular rib hanging below it, sized by frame analysis.
 */
function runRibs(mesh, info, net, params, warnings, onProgress) {
  const { nodes, edges, fixed, nodeLoad } = net;
  const n = nodes.length / 3, m = edges.length / 2, mat = params.material;
  // "below" = the side the load pushes towards
  const below = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const d = net.nodeNormals[3 * i] * params.down[0] + net.nodeNormals[3 * i + 1] * params.down[1] + net.nodeNormals[3 * i + 2] * params.down[2];
    const s = d >= 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) below[3 * i + k] = s * net.nodeNormals[3 * i + k];
  }
  const loads = new Float64Array(3 * n);
  let totalLoad = 0;
  for (let i = 0; i < n; i++) { totalLoad += nodeLoad[i]; for (let k = 0; k < 3; k++) loads[3 * i + k] = nodeLoad[i] * params.down[k]; }
  const clamp = net.nSupports < 3;
  if (clamp) warnings.push('fewer than three supports. supports are treated as clamped so the frame is stable.');
  const skinOn = params.skin === 'full' || params.skin === 'auto';
  const frame = new Frame(nodes, edges, below, fixed, clamp, skinOn ? net.triangles : null, true);
  const lim = { sigma: mat.strength / mat.safety, minWidth: mat.minDiameter, minDepth: mat.minDiameter, maxDepth: params.maxDepth, maxAspect: params.maxAspect, E: mat.modulus, safety: mat.safety };
  const fsd = sizeRibs(frame, loads, lim, { maxIter: params.sizingIter, onIter: (it, tot) => onProgress(it, tot, 0),
    skin: { mode: params.skin, tMin: params.skinMin, tMax: Math.max(params.skinMin, params.skinMax), keep: params.skinKeep } });

  // reactions from global equilibrium of each support node are not needed member by member:
  // report deflection, and check that sections satisfy the stress limit
  let dispMax = 0;
  const disp = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) { const u = frame.displacement(i); disp.set(u, 3 * i); dispMax = Math.max(dispMax, Math.hypot(...u)); }
  if (fsd.uMax > 1.02) warnings.push(`peak stress is ${(fsd.uMax * 100).toFixed(0)} % of allowable after sizing. a larger depth limit or coarser spacing clears this.`);

  // skin: thickness per network triangle -> per node (largest adjoining) -> per source vertex
  // (through each vertex's Voronoi cell), so the skin zones can be drawn and exported on the
  // design mesh itself
  let skinStats = null, skinVertex = null;
  if (skinOn) {
    const tr = net.triangles, nt = tr.length / 3, nodeSkin = new Float64Array(n);
    let aKept = 0, aAll = 0, vol = 0, tMax = 0;
    for (let t = 0; t < nt; t++) {
      const th = fsd.thickness[t], A = frame.shell.area[t];
      aAll += A;
      if (th > 0) { aKept += A; vol += A * th; tMax = Math.max(tMax, th); for (let k = 0; k < 3; k++) nodeSkin[tr[3 * t + k]] = Math.max(nodeSkin[tr[3 * t + k]], th); }
    }
    skinVertex = new Float64Array(info.nv);
    for (let v = 0; v < info.nv; v++) if (net.owner[v] >= 0) skinVertex[v] = nodeSkin[net.owner[v]];
    skinStats = { coverage: aKept / aAll, volume: vol, tMax, uMax: fsd.skinUMax };
    if (fsd.skinUMax > 1.02) warnings.push(`skin stress peaks at ${(fsd.skinUMax * 100).toFixed(0)} % of allowable. a larger maximum skin thickness clears this.`);
  }

  let hMax = 0, bMax = 0, volume = 0, lMin = Infinity, tight = 0;
  const count = [0, 0, 0, 0];
  for (let e = 0; e < m; e++) {
    hMax = Math.max(hMax, fsd.depth[e]); bMax = Math.max(bMax, fsd.width[e]);
    volume += fsd.width[e] * fsd.depth[e] * frame.length[e];
    lMin = Math.min(lMin, frame.length[e]);
    count[fsd.governs[e]]++;
    if (frame.length[e] - fsd.width[e] < mat.minOpening) tight++;
  }
  if (tight) warnings.push(`${tight} member(s) are shorter than the minimum opening (${mat.minOpening} mm) plus their own width. a larger node spacing clears this.`);
  if (count[3]) warnings.push(`${count[3]} member(s) reached the depth limit and were widened instead.`);
  // primary ribs: depth clearly above the minimum section
  const primaryMask = new Uint8Array(m);
  const cut = lim.minDepth + params.threshold * (hMax - lim.minDepth);
  for (let e = 0; e < m; e++) primaryMask[e] = fsd.depth[e] >= cut && hMax > lim.minDepth * 1.01 ? 1 : 0;
  const sp = extractSplines(nodes, edges, fixed, fsd.N, fsd.depth, frame.length, params.threshold, params.maxTurn, primaryMask);
  // per-curve rib data: depth at every node of the chain (largest adjoining member), width range,
  // and the lower edge of the rib (nodes moved below the surface by the depth)
  for (const c of sp.curves) {
    const k = c.nodes.length;
    c.depths = new Float64Array(k); c.widths = new Float64Array(k);
    c.edges.forEach((e, j) => {
      c.depths[j] = Math.max(c.depths[j], fsd.depth[e]); c.depths[j + 1] = Math.max(c.depths[j + 1], fsd.depth[e]);
      c.widths[j] = Math.max(c.widths[j], fsd.width[e]); c.widths[j + 1] = Math.max(c.widths[j + 1], fsd.width[e]);
    });
    if (c.closed) { c.depths[0] = c.depths[k - 1] = Math.max(c.depths[0], c.depths[k - 1]); c.widths[0] = c.widths[k - 1] = Math.max(c.widths[0], c.widths[k - 1]); }
    const low = new Float64Array(3 * k);
    c.nodes.forEach((nd, j) => { for (let d = 0; d < 3; d++) low[3 * j + d] = nodes[3 * nd + d] + below[3 * nd + d] * c.depths[j]; });
    c.lowerPoints = low; c.lowerCurve = interpolateBSpline(low);
    c.wMax = Math.max(...c.widths); c.wMin = Math.min(...c.widths);
    c.volume = c.edges.reduce((a, e) => a + fsd.width[e] * fsd.depth[e] * frame.length[e], 0);
  }
  let pT = 0, pC = 0;
  for (let e = 0; e < m; e++) if (primaryMask[e]) { if (fsd.N[e] >= 0) pT++; else pC++; }
  return {
    method: 'ribs', params, warnings,
    network: { nodes, edges, fixed, nodeLoad, nSupports: net.nSupports },
    x: nodes, below, force: fsd.N, moment: fsd.My, length: frame.length, displacement: disp,
    skinVertex, skinThickness: fsd.thickness, triangles: skinOn ? net.triangles : null,
    width: fsd.width, depth: fsd.depth, diameter: fsd.depth, governs: fsd.governs, utilisation: fsd.utilisation, primary: sp.primary,
    curves: sp.curves,
    stats: {
      iterations: fsd.iterations, nodes: n, members: m, minLength: lMin, totalLoad,
      dispMax, utilisationMax: fsd.uMax, depthMax: hMax, widthMax: bMax,
      volume, skin: skinStats, mass: ((volume + (skinStats ? skinStats.volume : 0)) / 1000) * mat.density,
      nMin: count[0], nStrength: count[1], nBuckling: count[2], nCapped: count[3],
      primaryMembers: pT + pC, primaryTension: pT, primaryCompression: pC,
      curvesPrimary: sp.curves.filter((c) => c.tier === 'primary').length, curvesSecondary: sp.curves.filter((c) => c.tier === 'secondary').length,
      meshArea: info.totalArea,
    },
  };
}

// ---- exports -----------------------------------------------------------------------------------

const selectCurves = (result, includeSecondary) => result.curves.filter((c) => includeSecondary || c.tier === 'primary');

/**
 * IGES. Level 1 primary curves, 2 secondary, 3 supports; red = tension, blue = compression.
 * Rib results add the lower edge of every rib on level 4 (primary) and 5 (secondary), in the
 * same order, so lofting a surface curve to its lower edge gives the rib's mid-plane.
 */
export function exportIGES(result, { includeSecondary = true, polyline = false } = {}) {
  const ents = [];
  let maxCoord = 0;
  for (const v of result.x) maxCoord = Math.max(maxCoord, Math.abs(v));
  const ribs = result.method === 'ribs';
  const poly = (pts) => {
    const k = pts.length / 3, knots = new Float64Array(k + 2);
    for (let i = 0; i < k; i++) knots[i + 1] = i / (k - 1);
    knots[k + 1] = 1;
    return { degree: 1, knots, control: pts };
  };
  const list = selectCurves(result, includeSecondary);
  list.forEach((c) => {
    const base = { type: 'curve', level: c.tier === 'primary' ? 1 : 2, colour: c.force >= 0 ? 'red' : 'blue', label: (ribs ? 'H' : 'D') + c.dMax.toFixed(2) };
    ents.push({ ...base, ...(polyline ? poly(c.points) : { degree: c.curve.degree, knots: c.curve.knots, control: c.curve.control }) });
  });
  if (ribs) list.forEach((c) => {
    const base = { type: 'curve', level: c.tier === 'primary' ? 4 : 5, colour: 'cyan', label: 'W' + c.wMax.toFixed(2) };
    ents.push({ ...base, ...(polyline ? poly(c.lowerPoints) : { degree: c.lowerCurve.degree, knots: c.lowerCurve.knots, control: c.lowerCurve.control }) });
  });
  const { nodes, fixed } = result.network;
  for (let i = 0; i < fixed.length; i++) if (fixed[i]) ents.push({ type: 'point', xyz: Array.from(nodes.subarray(3 * i, 3 * i + 3)), level: 3, colour: 'green', label: 'SUPPORT' });
  return writeIGES(ents, { units: 'MM', name: 'form-finding', maxCoord });
}

/** One row per exported curve, in the same order as the IGES entities. */
export function exportCSV(result, { includeSecondary = true } = {}) {
  const list = selectCurves(result, includeSecondary);
  if (result.method === 'ribs') {
    const rows = ['curve,tier,axial,peak_axial_N,depth_max_mm,depth_min_mm,width_max_mm,width_min_mm,length_mm,volume_mm3,nodes,depth_at_nodes_mm'];
    list.forEach((c, i) => rows.push([i + 1, c.tier, c.force >= 0 ? 'tension' : 'compression', c.force.toFixed(4), c.dMax.toFixed(3), c.dMin.toFixed(3), c.wMax.toFixed(3), c.wMin.toFixed(3),
      c.length.toFixed(3), c.volume.toFixed(2), c.nodes.length, Array.from(c.depths, (v) => v.toFixed(2)).join(' ')].join(',')));
    return rows.join('\n') + '\n';
  }
  const rows = ['curve,tier,action,peak_force_N,diameter_max_mm,diameter_min_mm,length_mm,volume_mm3,nodes'];
  list.forEach((c, i) => {
    rows.push([i + 1, c.tier, c.force >= 0 ? 'tension' : 'compression', c.force.toFixed(4), c.dMax.toFixed(3), c.dMin.toFixed(3), c.length.toFixed(3), c.volume.toFixed(2), c.nodes.length].join(','));
  });
  return rows.join('\n') + '\n';
}

/**
 * Skin zones as an OBJ of the design mesh: only the faces that carry skin, with the thickness
 * written as a grey vertex colour (thickness / scale), the same convention as the load input.
 */
export function exportSkinOBJ(result, mesh) {
  const t = result.skinVertex, scale = Math.max(result.stats.skin.tMax, 1e-9);
  const lines = [`# form_finder skin zones. vertex colour r=g=b = thickness / ${scale.toFixed(4)} mm`];
  const P = mesh.positions;
  for (let v = 0; v < t.length; v++) { const c = (t[v] / scale).toFixed(4); lines.push(`v ${P[3 * v]} ${P[3 * v + 1]} ${P[3 * v + 2]} ${c} ${c} ${c}`); }
  const F = mesh.triangles;
  for (let f = 0; f < F.length / 3; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    if (t[a] > 0 && t[b] > 0 && t[c] > 0) lines.push(`f ${a + 1} ${b + 1} ${c + 1}`);
  }
  return lines.join('\n') + '\n';
}

/** Everything, for scripting (e.g. sweeping each member at its own section in Grasshopper). */
export function exportJSON(result) {
  const r3 = (a) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4);
  const ribs = result.method === 'ribs';
  return JSON.stringify({
    units: { length: 'mm', force: 'N', moment: 'N.mm' },
    method: result.method,
    parameters: result.params,
    stats: result.stats,
    nodes: r3(result.x),
    ...(ribs ? { depthDirection: r3(result.below), displacement: r3(result.displacement) } : {}),
    ...(ribs && result.triangles ? { skin: { triangles: Array.from(result.triangles), thickness: r3(result.skinThickness) } } : {}),
    supports: Array.from(result.network.fixed).flatMap((f, i) => (f ? [i] : [])),
    ...(ribs ? {} : { reactions: Array.from(result.network.fixed).flatMap((f, i) => (f ? [r3(result.reactions.subarray(3 * i, 3 * i + 3))] : [])) }),
    members: Array.from({ length: result.force.length }, (_, e) => ({
      a: result.network.edges[2 * e], b: result.network.edges[2 * e + 1],
      force: +result.force[e].toFixed(5), length: +result.length[e].toFixed(3), primary: !!result.primary[e],
      ...(ribs ? { width: +result.width[e].toFixed(3), depth: +result.depth[e].toFixed(3), moment: +result.moment[e].toFixed(4), utilisation: +result.utilisation[e].toFixed(3) }
               : { diameter: +result.diameter[e].toFixed(3) }),
    })),
    curves: result.curves.map((c) => ({
      tier: c.tier, force: +c.force.toFixed(5), length: +c.length.toFixed(3), nodes: c.nodes, degree: c.curve.degree, knots: r3(c.curve.knots), control: r3(c.curve.control),
      ...(ribs ? { depths: r3(c.depths), widths: r3(c.widths), lowerControl: r3(c.lowerCurve.control) } : { diameterMax: +c.dMax.toFixed(3) }),
    })),
  });
}
