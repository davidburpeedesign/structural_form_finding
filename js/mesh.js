// Triangle-mesh helpers.

/** Build everything the pipeline needs from raw positions/triangles. */
export function analyseMesh(positions, triangles) {
  const nv = positions.length / 3, nt = triangles.length / 3;
  const area = new Float64Array(nv);        // lumped (barycentric) vertex areas
  const normals = new Float64Array(3 * nv); // area-weighted vertex normals
  const meanN = [0, 0, 0];
  let totalArea = 0;
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    const ux = positions[3 * b] - positions[3 * a], uy = positions[3 * b + 1] - positions[3 * a + 1], uz = positions[3 * b + 2] - positions[3 * a + 2];
    const vx = positions[3 * c] - positions[3 * a], vy = positions[3 * c + 1] - positions[3 * a + 1], vz = positions[3 * c + 2] - positions[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const A = 0.5 * Math.hypot(nx, ny, nz);
    totalArea += A;
    for (const v of [a, b, c]) {
      area[v] += A / 3;
      normals[3 * v] += nx; normals[3 * v + 1] += ny; normals[3 * v + 2] += nz;
    }
    meanN[0] += nx; meanN[1] += ny; meanN[2] += nz;
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]) || 1;
    normals[3 * v] /= l; normals[3 * v + 1] /= l; normals[3 * v + 2] /= l;
  }
  // vertex adjacency (CSR) with edge lengths
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const edgeCount = new Map();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const kk = key(triangles[3 * t + k], triangles[3 * t + (k + 1) % 3]);
      edgeCount.set(kk, (edgeCount.get(kk) || 0) + 1);
    }
  const deg = new Uint32Array(nv + 1);
  for (const kk of edgeCount.keys()) { deg[Math.floor(kk / nv) + 1]++; deg[(kk % nv) + 1]++; }
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const adjStart = deg.slice();
  const fill = deg.slice(0, nv);
  const adj = new Uint32Array(deg[nv]);
  const adjLen = new Float64Array(deg[nv]);
  const isBoundary = new Uint8Array(nv);
  let nonManifold = 0;
  for (const [kk, cnt] of edgeCount) {
    const a = Math.floor(kk / nv), b = kk % nv;
    const l = Math.hypot(positions[3 * a] - positions[3 * b], positions[3 * a + 1] - positions[3 * b + 1], positions[3 * a + 2] - positions[3 * b + 2]);
    adj[fill[a]] = b; adjLen[fill[a]++] = l;
    adj[fill[b]] = a; adjLen[fill[b]++] = l;
    if (cnt === 1) { isBoundary[a] = 1; isBoundary[b] = 1; }
    if (cnt > 2) nonManifold++;
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++)
    for (let k = 0; k < 3; k++) {
      const x = positions[3 * v + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  // guess the vertical axis from the dominant direction of the mean normal
  const an = meanN.map(Math.abs);
  const upAxis = an[0] > an[1] && an[0] > an[2] ? 0 : an[1] > an[2] ? 1 : 2;
  return { nv, nt, area, normals, adjStart, adj, adjLen, isBoundary, totalArea, nonManifold, min, max, upAxis,
           diag: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

/** Index of the mesh vertex closest to each xyz point. */
export function snapToVertices(positions, points) {
  const nv = positions.length / 3, np = points.length / 3;
  const out = new Uint32Array(np), dist = new Float64Array(np);
  for (let p = 0; p < np; p++) {
    let best = Infinity, bi = 0;
    const px = points[3 * p], py = points[3 * p + 1], pz = points[3 * p + 2];
    for (let v = 0; v < nv; v++) {
      const dx = positions[3 * v] - px, dy = positions[3 * v + 1] - py, dz = positions[3 * v + 2] - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = v; }
    }
    out[p] = bi; dist[p] = Math.sqrt(best);
  }
  return { index: out, dist };
}

/** Minimal binary heap keyed by a Float64Array of priorities. */
export class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, topV];
  }
}
