// Form-finding driver: scales the problem, picks starting force densities, optimises them and
// returns the equilibrium geometry with member forces in real units.

import { FDM, objective, initialForceDensities } from './fdm.js';
import { lbfgs } from './optimize.js';
import { alternatingSolve } from './mixed.js';

const softplus = (t) => (t > 30 ? t : Math.log1p(Math.exp(t)));
const sigmoid = (t) => 1 / (1 + Math.exp(-t));
const softplusInv = (y) => (y > 30 ? y : Math.log(Math.expm1(y)));

/**
 * @param net     network from buildNetwork ({nodes, nodeNormals, nodeLoad, edges, fixed})
 * @param params  { down:[x,y,z], spacing, mode:'mixed'|'tension'|'compression', lambda, slide, maxIter }
 * @param onProgress optional (iter, maxIter, J) => continue?
 */
export function formFind(net, params, onProgress) {
  const { nodes, nodeNormals, nodeLoad, edges, fixed } = net;
  const n = nodes.length / 3, m = edges.length / 2;
  const h = params.spacing;
  const mode = ['tension', 'compression'].includes(params.mode) ? params.mode : 'mixed';
  const down = params.down;

  // --- non-dimensionalise: lengths by node spacing, loads by the mean nodal load ---------------
  let c = [0, 0, 0], pSum = 0, nFree = 0;
  for (let i = 0; i < n; i++) { for (let k = 0; k < 3; k++) c[k] += nodes[3 * i + k] / n; if (!fixed[i]) { pSum += nodeLoad[i]; nFree++; } }
  const pBar = pSum / Math.max(1, nFree) || 1;
  const X = new Float64Array(3 * n), P = new Float64Array(3 * n);
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      X[3 * i + k] = (nodes[3 * i + k] - c[k]) / h;
      P[3 * i + k] = (nodeLoad[i] / pBar) * down[k];
      r2 = Math.max(r2, X[3 * i + k] * X[3 * i + k]);
    }
  }
  const size = 2 * Math.sqrt(r2);
  const fdm = new FDM(X, edges, fixed, P);
  const opts = {
    normals: nodeNormals,
    wt: params.slide ?? 0.1,
    lambda: params.lambda ?? 0.02,
    eps: 0.01,
    pin: net.nodeBoundary || null,
    pinWeight: params.rimWeight ?? 2,
    lmin: (params.minLength ?? 0) / h,
    beta: params.shortPenalty ?? 20 * Math.max(1, (params.lambda ?? 0.02) / 0.02),
    lpScale: 1 / (Math.max(1, nFree) * size), // load path measured against (total load x model size)
  };

  // --- optimisation -------------------------------------------------------------------------------
  // Single-sign networks give a definite, well-conditioned system, so they are solved first.
  // 'mixed' then releases the sign constraint starting from the better of the two: with signed
  // force densities the system is indefinite and a cold start lands next to singular states.
  const q = new Float64Array(m), gq = new Float64Array(m);
  const maxIter = params.maxIter ?? 300;
  let done = 0;
  const total = mode === 'mixed' ? Math.round(maxIter * 1.5) : maxIter;

  const run = (sign, theta0, iters) => {
    const toQ = (theta) => { for (let e = 0; e < m; e++) q[e] = sign === 0 ? theta[e] : sign * softplus(theta[e]); };
    const fn = (theta, g) => {
      toQ(theta);
      const r = objective(fdm, q, opts, gq);
      if (!Number.isFinite(r.J)) return Infinity;
      for (let e = 0; e < m; e++) g[e] = sign === 0 ? gq[e] : sign * sigmoid(theta[e]) * gq[e];
      return r.J;
    };
    const base = done;
    const res = lbfgs(fn, theta0, { maxIter: iters, onIter: (it, J) => (onProgress ? onProgress(base + it + 1, total, J) : true) });
    done = base + iters;
    toQ(res.x);
    return { q: Float64Array.from(q), J: res.f, iter: res.iter };
  };
  const singleSign = (sign, iters) => {
    // start from least-squares equilibrium on the target, clipped to the admissible sign
    const g0 = new Float64Array(m);
    let best = null;
    for (const alpha of [1e-2, 1e-1, 1]) {
      const q0 = initialForceDensities(fdm, alpha);
      const theta = new Float64Array(m);
      for (let e = 0; e < m; e++) theta[e] = softplusInv(Math.max(sign * q0[e], 0.05));
      for (let e = 0; e < m; e++) q[e] = sign * softplus(theta[e]);
      const J = objective(fdm, q, opts, g0).J;
      if (Number.isFinite(J) && (!best || J < best.J)) best = { theta, J };
    }
    if (!best) best = { theta: new Float64Array(m).fill(softplusInv(1)) };
    return run(sign, best.theta, iters);
  };

  let result, geometry = null;
  if (mode === 'compression') result = singleSign(-1, maxIter);
  else if (mode === 'tension') result = singleSign(1, maxIter);
  else {
    // Stage 1: alternating least squares finds signed force densities near equilibrium on the
    // target. Stage 2: from there the reduced (exact-equilibrium) problem is optimised directly.
    const q0 = initialForceDensities(fdm, 1e-2);
    const pre = Math.round(maxIter * 0.5);
    const alt = alternatingSolve(fdm, q0, opts, { outer: pre, rhoMax: params.rhoMax ?? 1e4, onIter: (it) => (onProgress ? onProgress(it, total, 0) : true) });
    done = pre;
    const g0 = new Float64Array(m);
    if (Number.isFinite(objective(fdm, alt.q, opts, g0).J)) result = run(0, alt.q, maxIter);
    else { result = { q: alt.q, iter: pre }; geometry = alt.x; }
    result.iter += pre;
  }
  q.set(result.q);
  const res = { iter: result.iter };
  let final = { J: NaN };
  if (geometry) fdm.x.set(geometry);
  else {
    final = objective(fdm, q, opts, null);
    if (!Number.isFinite(final.J)) throw new Error('form-finding diverged. Check that every part of the mesh can reach a support.');
  }
  const { worst, reactions } = fdm.residual(q);

  // --- back to real units -------------------------------------------------------------------------
  const x = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) x[3 * i + k] = fdm.x[3 * i + k] * h + c[k];
  const force = new Float64Array(m), length = new Float64Array(m);
  let loadPath = 0;
  for (let e = 0; e < m; e++) {
    const a = edges[2 * e], b = edges[2 * e + 1];
    length[e] = Math.hypot(x[3 * a] - x[3 * b], x[3 * a + 1] - x[3 * b + 1], x[3 * a + 2] - x[3 * b + 2]);
    force[e] = q[e] * (length[e] / h) * pBar; // f = q l, rescaled
    loadPath += Math.abs(force[e]) * length[e];
  }
  // deviation normal to the surface, and drift along it
  const deviation = new Float64Array(n);
  let devMax = 0, devSq = 0, driftMax = 0, driftSq = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i]) continue;
    let dn = 0, d2 = 0;
    for (let k = 0; k < 3; k++) { const d = x[3 * i + k] - nodes[3 * i + k]; dn += d * nodeNormals[3 * i + k]; d2 += d * d; }
    deviation[i] = dn;
    const drift = Math.sqrt(Math.max(0, d2 - dn * dn));
    devMax = Math.max(devMax, Math.abs(dn)); devSq += dn * dn;
    driftMax = Math.max(driftMax, drift); driftSq += drift * drift;
  }
  const react = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) if (fixed[i]) for (let k = 0; k < 3; k++) react[3 * i + k] = reactions[3 * i + k] * pBar;
  return {
    x, force, length, deviation, reactions: react,
    stats: { iterations: res.iter, objective: final.J, residual: worst * pBar, residualRel: worst, exact: !geometry, devMax, devRms: Math.sqrt(devSq / Math.max(1, nFree)), driftMax, driftRms: Math.sqrt(driftSq / Math.max(1, nFree)), loadPath, totalLoad: nodeLoad.reduce((a, b) => a + b, 0) },
  };
}
