// Build the form-finding network from the load mesh.
//
// The imported triangulation is only a design domain: its edges are far denser than anything
// printable and their directions are arbitrary. Nodes are therefore re-sampled on the surface at
// a chosen spacing (farthest-point sampling by geodesic distance, supports first) and connected
// through the dual of their geodesic Voronoi diagram, which gives an isotropic triangulated
// network. Each node collects the load of its own Voronoi cell, so total load is preserved.

import { MinHeap } from './mesh.js';

/**
 * @param mesh      {positions, triangles}
 * @param info      result of analyseMesh
 * @param vertexLoad Float64Array(nv): load magnitude lumped at each mesh vertex (scalar * area * pressure)
 * @param supportVerts mesh vertex index per support
 * @param spacing   target node spacing (model units)
 */
export function buildNetwork(mesh, info, vertexLoad, supportVerts, spacing, maxNodes = 1200) {
  const { positions, triangles } = mesh;
  const { nv, adjStart, adj, adjLen } = info;
  const dist = new Float64Array(nv).fill(Infinity);
  const owner = new Int32Array(nv).fill(-1);
  const seeds = [];

  const addSeed = (v) => {
    const id = seeds.length;
    seeds.push(v);
    const heap = new MinHeap();
    dist[v] = 0; owner[v] = id; heap.push(0, v);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const w = adj[k], nd = d + adjLen[k];
        if (nd < dist[w]) { dist[w] = nd; owner[w] = id; heap.push(nd, w); }
      }
    }
  };

  const seen = new Set();
  for (const v of supportVerts) if (!seen.has(v)) { seen.add(v); addSeed(v); }
  const nSupports = seeds.length;
  if (nSupports === 0) throw new Error('at least one support is required.');
  for (;;) {
    let far = -1, fd = 0;
    for (let v = 0; v < nv; v++) {
      if (dist[v] === Infinity) continue; // other connected component: unreachable from any support
      if (dist[v] > fd) { fd = dist[v]; far = v; }
    }
    if (far < 0 || fd < spacing * 0.75 || seeds.length >= maxNodes) break;
    addSeed(far);
  }
  const nn = seeds.length;

  // Dual connectivity. Count how many mesh edges cross each Voronoi boundary; a single crossing
  // is usually the spurious diagonal of a four-cell corner, so two are required.
  const crossings = new Map();
  for (let u = 0; u < nv; u++) {
    const a = owner[u];
    if (a < 0) continue;
    for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
      const w = adj[k];
      if (w <= u) continue;
      const b = owner[w];
      if (b < 0 || b === a) continue;
      const kk = a < b ? a * nn + b : b * nn + a;
      crossings.set(kk, (crossings.get(kk) || 0) + 1);
    }
  }
  const edgeSet = new Set();
  for (const [kk, c] of crossings) if (c >= 2) edgeSet.add(kk);
  // every Delaunay triangle (mesh face touching three cells) contributes its three edges,
  // which keeps the network triangulated even where cell boundaries are short
  const tri = [];
  for (let t = 0; t < triangles.length / 3; t++) {
    const a = owner[triangles[3 * t]], b = owner[triangles[3 * t + 1]], c = owner[triangles[3 * t + 2]];
    if (a < 0 || a === b || b === c || a === c) continue;
    tri.push([a, b, c]);
  }
  const triCount = new Map();
  for (const [a, b, c] of tri)
    for (const [p, q] of [[a, b], [b, c], [a, c]]) {
      const kk = p < q ? p * nn + q : q * nn + p;
      triCount.set(kk, (triCount.get(kk) || 0) + 1);
    }
  for (const [kk, c] of triCount) if (c <= 2) edgeSet.add(kk);

  // unique Delaunay triangles, used as skin elements; their edges are always network members
  const triKeys = new Set(), triList = [];
  for (const [a, b, c] of tri) {
    const k = [a, b, c].sort((p, q) => p - q).join(',');
    if (triKeys.has(k)) continue;
    triKeys.add(k); triList.push(a, b, c);
    for (const [p, q] of [[a, b], [b, c], [a, c]]) edgeSet.add(p < q ? p * nn + q : q * nn + p);
  }
  const edges = new Uint32Array(2 * edgeSet.size);
  let e = 0;
  for (const kk of edgeSet) { edges[2 * e] = Math.floor(kk / nn); edges[2 * e + 1] = kk % nn; e++; }

  const nodes = new Float64Array(3 * nn), nodeNormals = new Float64Array(3 * nn), nodeLoad = new Float64Array(nn);
  const nodeBoundary = new Uint8Array(nn);
  for (let i = 0; i < nn; i++) {
    const v = seeds[i];
    nodes.set(positions.subarray(3 * v, 3 * v + 3), 3 * i);
    nodeNormals.set(info.normals.subarray(3 * v, 3 * v + 3), 3 * i);
    nodeBoundary[i] = info.isBoundary[v];
  }
  let unassigned = 0;
  for (let v = 0; v < nv; v++) {
    if (owner[v] >= 0) nodeLoad[owner[v]] += vertexLoad[v];
    else unassigned += vertexLoad[v];
  }
  const fixed = new Uint8Array(nn);
  for (let i = 0; i < nSupports; i++) fixed[i] = 1;
  return { triangles: Uint32Array.from(triList), owner, nodes, nodeNormals, nodeLoad, nodeBoundary, edges, fixed, nSupports, seeds: Uint32Array.from(seeds), unassignedLoad: unassigned };
}
