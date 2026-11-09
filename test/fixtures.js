import { readFileSync } from 'node:fs';
import { parseOBJ } from '../js/io.js';
import { analyseMesh, snapToVertices } from '../js/mesh.js';
import { buildNetwork } from '../js/network.js';

export function exampleMesh() {
  const mesh = parseOBJ(readFileSync(new URL('../examples/load_mesh.obj', import.meta.url), 'utf8'));
  return { mesh, info: analyseMesh(mesh.positions, mesh.triangles) };
}

/** Support points placed at fractional (u, v) positions of the mesh's plan bounding box. */
export function supportsAt(mesh, info, uv, up = 1) {
  const [a, b] = [0, 1, 2].filter((k) => k !== up);
  const pts = [];
  for (const [u, v] of uv) {
    const p = [0, 0, 0];
    p[a] = info.min[a] + u * (info.max[a] - info.min[a]);
    p[b] = info.min[b] + v * (info.max[b] - info.min[b]);
    // drop onto the surface: nearest vertex in plan
    let best = Infinity, bi = 0;
    for (let i = 0; i < info.nv; i++) {
      const d = (mesh.positions[3 * i + a] - p[a]) ** 2 + (mesh.positions[3 * i + b] - p[b]) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    pts.push(...mesh.positions.subarray(3 * bi, 3 * bi + 3));
  }
  return snapToVertices(mesh.positions, Float64Array.from(pts)).index;
}

export function exampleNetwork(uv, spacing = 10, pressure = 0.001) {
  const { mesh, info } = exampleMesh();
  const load = new Float64Array(info.nv);
  for (let i = 0; i < info.nv; i++) load[i] = pressure * info.area[i] * (mesh.scalars ? mesh.scalars[i] : 1);
  const sup = supportsAt(mesh, info, uv);
  return { mesh, info, net: buildNetwork(mesh, info, load, sup, spacing) };
}
