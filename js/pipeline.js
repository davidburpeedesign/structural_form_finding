// End-to-end run: mesh + supports + parameters -> equilibrium network, member sizes, curves.
// Pure computation, no DOM: used by the web worker and by the tests.

import { analyseMesh, snapToVertices } from './mesh.js';
import { buildNetwork } from './network.js';
import { formFind } from './formfind.js';
import { sizeMembers, DEFAULT_MATERIAL } from './sizing.js';
import { extractSplines } from './splines.js';
import { writeIGES } from './iges.js';

export const DEFAULTS = {
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
  if (info.nonManifold) warnings.push(`${info.nonManifold} non-manifold edges in the mesh; results near them may be unreliable.`);
  if (!mesh.scalars) warnings.push('The mesh has no vertex colours, so the load scalar is 1.0 everywhere.');

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
  if (offMax > 0.5 * params.spacing) warnings.push(`A support lies ${offMax.toFixed(1)} mm from the surface; it is connected to the nearest part of the network.`);
  if (net.unassignedLoad > 0) warnings.push('Part of the mesh is not connected to any support and carries no members.');
  if (net.nSupports < 3) warnings.push('Fewer than three supports: the result is in equilibrium for this load only and has no stability against any other load.');
  const m = net.edges.length / 2, n = net.nodes.length / 3;
  if (n >= 1200) warnings.push('Node limit reached (1200); the network is coarser than the requested spacing in places.');

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
  if (tight) warnings.push(`${tight} member(s) are shorter than the minimum opening (${params.material.minOpening} mm) plus their own diameter; increase the node spacing.`);
  if (ff.stats.devMax > 2 * params.spacing) warnings.push(`The equilibrium shape departs from the surface by up to ${ff.stats.devMax.toFixed(1)} mm. This surface is not close to funicular for these supports and this load direction.`);

  const signs = { tension: 0, compression: 0 };
  for (let e = 0; e < m; e++) if (Math.abs(ff.force[e]) >= params.threshold * sp.fmax) signs[ff.force[e] > 0 ? 'tension' : 'compression']++;

  return {
    params, warnings,
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

// ---- exports -----------------------------------------------------------------------------------

const selectCurves = (result, includeSecondary) => result.curves.filter((c) => includeSecondary || c.tier === 'primary');

/** IGES: level 1 = primary curves, 2 = secondary, 3 = supports. Red = tension, blue = compression. */
export function exportIGES(result, { includeSecondary = true, polyline = false } = {}) {
  const ents = [];
  let maxCoord = 0;
  for (const v of result.x) maxCoord = Math.max(maxCoord, Math.abs(v));
  selectCurves(result, includeSecondary).forEach((c) => {
    const base = { type: 'curve', level: c.tier === 'primary' ? 1 : 2, colour: c.force >= 0 ? 'red' : 'blue', label: 'D' + c.dMax.toFixed(2) };
    if (polyline) {
      const k = c.points.length / 3;
      const knots = new Float64Array(k + 2);
      for (let i = 0; i < k; i++) knots[i + 1] = i / (k - 1);
      knots[k + 1] = 1;
      ents.push({ ...base, degree: 1, knots, control: c.points });
    } else ents.push({ ...base, degree: c.curve.degree, knots: c.curve.knots, control: c.curve.control });
  });
  const { nodes, fixed } = result.network;
  for (let i = 0; i < fixed.length; i++) if (fixed[i]) ents.push({ type: 'point', xyz: Array.from(nodes.subarray(3 * i, 3 * i + 3)), level: 3, colour: 'green', label: 'SUPPORT' });
  return writeIGES(ents, { units: 'MM', name: 'form-finding', maxCoord });
}

/** One row per exported curve, in the same order as the IGES entities. */
export function exportCSV(result, { includeSecondary = true } = {}) {
  const rows = ['curve,tier,action,peak_force_N,diameter_max_mm,diameter_min_mm,length_mm,volume_mm3,nodes'];
  selectCurves(result, includeSecondary).forEach((c, i) => {
    rows.push([i + 1, c.tier, c.force >= 0 ? 'tension' : 'compression', c.force.toFixed(4), c.dMax.toFixed(3), c.dMin.toFixed(3), c.length.toFixed(3), c.volume.toFixed(2), c.nodes.length].join(','));
  });
  return rows.join('\n') + '\n';
}

/** Everything, for scripting (e.g. piping with per-member diameters in Grasshopper). */
export function exportJSON(result) {
  const r3 = (a) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4);
  return JSON.stringify({
    units: { length: 'mm', force: 'N' },
    parameters: result.params,
    stats: result.stats,
    nodes: r3(result.x),
    supports: Array.from(result.network.fixed).flatMap((f, i) => (f ? [i] : [])),
    reactions: Array.from(result.network.fixed).flatMap((f, i) => (f ? [r3(result.reactions.subarray(3 * i, 3 * i + 3))] : [])),
    members: Array.from({ length: result.force.length }, (_, e) => ({
      a: result.network.edges[2 * e], b: result.network.edges[2 * e + 1],
      force: +result.force[e].toFixed(5), diameter: +result.diameter[e].toFixed(3), length: +result.length[e].toFixed(3), primary: !!result.primary[e],
    })),
    curves: result.curves.map((c) => ({ tier: c.tier, force: +c.force.toFixed(5), diameterMax: +c.dMax.toFixed(3), length: +c.length.toFixed(3), nodes: c.nodes, degree: c.curve.degree, knots: r3(c.curve.knots), control: r3(c.curve.control) })),
  });
}
