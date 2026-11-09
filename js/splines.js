// Turn the equilibrium network into continuous curves.
//
// 1. keep members whose force is above a fraction of the largest force ("primary" members)
// 2. at every node pair up members that continue most nearly straight through it
// 3. walk the pairings into chains and interpolate each with a cubic B-spline

import { solveDense } from './linalg.js';

/**
 * @returns chains: [{ nodes:[...], edges:[...], closed }]
 */
export function chainMembers(x, edges, keep, fixed, maxTurnDeg = 50) {
  const n = x.length / 3, m = edges.length / 2;
  const inc = Array.from({ length: n }, () => []);
  for (let e = 0; e < m; e++) if (keep[e]) { inc[edges[2 * e]].push(e); inc[edges[2 * e + 1]].push(e); }
  // partner[2e + side] = member continuing through node edges[2e + side], or -1
  const partner = new Int32Array(2 * m).fill(-1);
  const sideOf = (e, node) => (edges[2 * e] === node ? 0 : 1);
  const cosMax = -Math.cos((maxTurnDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const list = inc[i];
    if (list.length < 2 || fixed[i]) continue; // curves end at supports
    const dirs = list.map((e) => {
      const j = edges[2 * e] === i ? edges[2 * e + 1] : edges[2 * e];
      const d = [x[3 * j] - x[3 * i], x[3 * j + 1] - x[3 * i + 1], x[3 * j + 2] - x[3 * i + 2]];
      const l = Math.hypot(...d) || 1;
      return d.map((v) => v / l);
    });
    const cand = [];
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const c = dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1] + dirs[a][2] * dirs[b][2];
        if (c < cosMax) cand.push([c, a, b]);
      }
    cand.sort((p, q) => p[0] - q[0]); // straightest first
    const used = new Uint8Array(list.length);
    for (const [, a, b] of cand) {
      if (used[a] || used[b]) continue;
      used[a] = used[b] = 1;
      partner[2 * list[a] + sideOf(list[a], i)] = list[b];
      partner[2 * list[b] + sideOf(list[b], i)] = list[a];
    }
  }
  const visited = new Uint8Array(m);
  const chains = [];
  const walk = (e0, startSide) => {
    // walk from member e0 leaving through its 'startSide' end; returns nodes/edges in order
    const nodes = [], es = [];
    let e = e0, side = startSide;
    for (;;) {
      visited[e] = 1; es.push(e);
      const node = edges[2 * e + side];
      nodes.push(node);
      const nx = partner[2 * e + side];
      if (nx < 0 || visited[nx]) return { nodes, es, closed: nx === e0 && es.length > 2 };
      side = edges[2 * nx] === node ? 1 : 0;
      e = nx;
    }
  };
  // open chains first: start at members with a free end
  for (let pass = 0; pass < 2; pass++)
    for (let e = 0; e < m; e++) {
      if (!keep[e] || visited[e]) continue;
      const end0 = partner[2 * e] < 0, end1 = partner[2 * e + 1] < 0;
      if (pass === 0 && !end0 && !end1) continue;
      const startSide = end0 ? 1 : 0; // walk away from the free end
      const w = walk(e, startSide);
      const first = edges[2 * e + (1 - startSide)];
      chains.push({ nodes: [first, ...w.nodes], edges: w.es, closed: w.closed });
    }
  return chains;
}

/** Clamped cubic B-spline interpolating the given points (chord-length parameters, averaged knots). */
export function interpolateBSpline(pts) {
  const n = pts.length / 3;
  const p = Math.min(3, n - 1);
  const u = new Float64Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[3 * i] - pts[3 * i - 3], pts[3 * i + 1] - pts[3 * i - 2], pts[3 * i + 2] - pts[3 * i - 1]);
    u[i] = total;
  }
  for (let i = 0; i < n; i++) u[i] = total > 0 ? u[i] / total : i / (n - 1);
  const knots = new Float64Array(n + p + 1);
  for (let i = 0; i <= p; i++) { knots[i] = 0; knots[n + i] = 1; }
  for (let j = 1; j < n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += u[i];
    knots[j + p] = s / p;
  }
  if (p < 2) return { degree: p, knots, control: Float64Array.from(pts), params: u };
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const span = findSpan(n - 1, p, u[i], knots);
    const N = basisFuns(span, u[i], p, knots);
    for (let k = 0; k <= p; k++) A[i * n + span - p + k] = N[k];
  }
  const control = new Float64Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) b[i] = pts[3 * i + c];
    const sol = solveDense(A, b, n);
    for (let i = 0; i < n; i++) control[3 * i + c] = sol[i];
  }
  return { degree: p, knots, control, params: u };
}

function findSpan(n, p, u, U) {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function basisFuns(i, u, p, U) {
  const N = new Float64Array(p + 1), left = new Float64Array(p + 1), right = new Float64Array(p + 1);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j]; right[j] = U[i + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const t = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * t;
      saved = left[j - r] * t;
    }
    N[j] = saved;
  }
  return N;
}

/** Evaluate a B-spline at parameter t in [0, 1]. */
export function evalBSpline(curve, t) {
  const n = curve.control.length / 3, p = curve.degree;
  const span = findSpan(n - 1, p, t, curve.knots);
  const N = basisFuns(span, t, p, curve.knots);
  const out = [0, 0, 0];
  for (let k = 0; k <= p; k++) for (let c = 0; c < 3; c++) out[c] += N[k] * curve.control[3 * (span - p + k) + c];
  return out;
}

/** Sample a curve as a polyline (for display). */
export function sampleBSpline(curve, perSpan = 8) {
  const n = curve.control.length / 3;
  const count = Math.max(2, (n - 1) * perSpan + 1);
  const out = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) out.set(evalBSpline(curve, i / (count - 1)), 3 * i);
  return out;
}

/**
 * Full extraction. Returns curves with per-curve engineering attributes.
 * @param threshold fraction of the largest member force below which a member is "secondary"
 */
export function extractSplines(x, edges, fixed, force, diameter, length, threshold, maxTurnDeg = 50) {
  const m = edges.length / 2;
  let fmax = 0;
  for (let e = 0; e < m; e++) fmax = Math.max(fmax, Math.abs(force[e]));
  const primary = new Uint8Array(m), secondary = new Uint8Array(m);
  for (let e = 0; e < m; e++) (Math.abs(force[e]) >= threshold * fmax ? primary : secondary)[e] = 1;
  const build = (keep, tier) =>
    chainMembers(x, edges, keep, fixed, maxTurnDeg).map((ch) => {
      const pts = new Float64Array(3 * ch.nodes.length);
      ch.nodes.forEach((nd, i) => pts.set(x.subarray(3 * nd, 3 * nd + 3), 3 * i));
      let len = 0, dMax = 0, dMin = Infinity, fPeak = 0, vol = 0;
      for (const e of ch.edges) {
        len += length[e];
        dMax = Math.max(dMax, diameter[e]); dMin = Math.min(dMin, diameter[e]);
        if (Math.abs(force[e]) > Math.abs(fPeak)) fPeak = force[e];
        vol += (Math.PI * diameter[e] ** 2 * length[e]) / 4;
      }
      return { tier, nodes: ch.nodes, edges: ch.edges, closed: ch.closed, points: pts, curve: interpolateBSpline(pts), length: len, dMax, dMin, force: fPeak, volume: vol };
    });
  const curves = [...build(primary, 'primary'), ...build(secondary, 'secondary')];
  curves.sort((a, b) => (a.tier === b.tier ? Math.abs(b.force) - Math.abs(a.force) : a.tier === 'primary' ? -1 : 1));
  return { curves, primary, fmax };
}
