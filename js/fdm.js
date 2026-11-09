// Force-density method with signed force densities, plus the objective and its adjoint gradient.
//
// Conventions
//   q_e = f_e / l_e, tension positive.
//   Equilibrium of free node i:  sum_e q_e (x_i - x_j) = p_i      ->   D(q) x_free = p - D_fs(q) x_fixed
//   The solve is linear in x for given q; mixed-sign q makes D symmetric indefinite.

import { bandFactor, bandSolve, reverseCuthillMcKee } from './linalg.js';

export class FDM {
  /**
   * @param nodes  Float64Array(3n) target positions (fixed nodes stay here)
   * @param edges  Uint32Array(2m)
   * @param fixed  Uint8Array(n)
   * @param loads  Float64Array(3n) nodal load vectors
   */
  constructor(nodes, edges, fixed, loads) {
    this.n = nodes.length / 3; this.m = edges.length / 2;
    this.target = nodes; this.edges = edges; this.fixed = fixed; this.loads = loads;
    this.freeIndex = new Int32Array(this.n).fill(-1);
    // Free nodes are numbered by reverse Cuthill-McKee so that D is narrowly banded.
    const local = new Int32Array(this.n).fill(-1);
    let nf = 0;
    for (let i = 0; i < this.n; i++) if (!fixed[i]) local[i] = nf++;
    const adjacency = Array.from({ length: nf }, () => []);
    for (let e = 0; e < this.m; e++) {
      const a = local[edges[2 * e]], b = local[edges[2 * e + 1]];
      if (a >= 0 && b >= 0) { adjacency[a].push(b); adjacency[b].push(a); }
    }
    const perm = reverseCuthillMcKee(adjacency), inv = new Int32Array(nf);
    for (let k = 0; k < nf; k++) inv[perm[k]] = k;
    for (let i = 0; i < this.n; i++) if (local[i] >= 0) this.freeIndex[i] = inv[local[i]];
    let bw = 0;
    for (let e = 0; e < this.m; e++) {
      const a = this.freeIndex[edges[2 * e]], b = this.freeIndex[edges[2 * e + 1]];
      if (a >= 0 && b >= 0) bw = Math.max(bw, Math.abs(a - b));
    }
    this.nf = nf; this.bw = bw;
    this.x = Float64Array.from(nodes);
    this.D = new Float64Array(nf * (bw + 1));
    this.F = null;
  }

  /** Solve geometry for force densities q. Returns false if the system is singular / blew up. */
  solve(q) {
    const { n, m, nf, edges, freeIndex, target, loads, D } = this;
    const w = this.bw + 1;
    D.fill(0);
    const rhs = new Float64Array(3 * nf);
    for (let i = 0; i < n; i++) {
      const fi = freeIndex[i];
      if (fi >= 0) { rhs[3 * fi] = loads[3 * i]; rhs[3 * fi + 1] = loads[3 * i + 1]; rhs[3 * fi + 2] = loads[3 * i + 2]; }
    }
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1], qe = q[e];
      const fa = freeIndex[a], fb = freeIndex[b];
      if (fa >= 0) D[fa * w] += qe;
      if (fb >= 0) D[fb * w] += qe;
      if (fa >= 0 && fb >= 0) { if (fa > fb) D[fa * w + (fa - fb)] -= qe; else D[fb * w + (fb - fa)] -= qe; }
      else if (fa >= 0) for (let k = 0; k < 3; k++) rhs[3 * fa + k] += qe * target[3 * b + k];
      else if (fb >= 0) for (let k = 0; k < 3; k++) rhs[3 * fb + k] += qe * target[3 * a + k];
    }
    this.F = bandFactor(D, nf, this.bw);
    if (!(this.F.minPivot > 1e-12 * this.F.maxPivot)) return false;
    bandSolve(this.F, rhs, 3);
    const x = this.x;
    for (let i = 0; i < n; i++) {
      const fi = freeIndex[i];
      if (fi < 0) continue;
      for (let k = 0; k < 3; k++) {
        const v = rhs[3 * fi + k];
        if (!Number.isFinite(v)) return false;
        x[3 * i + k] = v;
      }
    }
    return true;
  }

  /** Solve D mu = g for three interleaved right-hand sides using the current factorisation. */
  adjoint(g) { return bandSolve(this.F, g, 3); }

  /**
   * Out-of-balance force sum_e q_e (x_i - x_j) - p_i at every node. At free nodes it should vanish
   * (worst = largest norm); at fixed nodes it is the support reaction.
   */
  residual(q) {
    const { n, m, edges, fixed, loads, x } = this;
    const r = Float64Array.from(loads);
    for (let i = 0; i < 3 * n; i++) r[i] = -r[i];
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      for (let k = 0; k < 3; k++) {
        const u = q[e] * (x[3 * a + k] - x[3 * b + k]);
        r[3 * a + k] += u; r[3 * b + k] -= u;
      }
    }
    let worst = 0;
    for (let i = 0; i < n; i++) if (!fixed[i]) worst = Math.max(worst, Math.hypot(r[3 * i], r[3 * i + 1], r[3 * i + 2]));
    return { worst, reactions: r };
  }
}

/**
 * Objective  J = fit + lambda * loadPath
 *   fit      = mean over free nodes of [ wt |d|^2 + (1 - wt) (d.n)^2 ],  d = x - target
 *              (normal deviation is penalised fully, sliding along the surface only by wt)
 *   loadPath = sum_e |q_e| l_e^2 = sum_e |f_e| l_e   (proportional to material volume at constant stress)
 *   plus a penalty on members shorter than lmin.
 * Returns J and writes dJ/dq into grad.
 */
export function objective(fdm, q, opts, grad) {
  const { n, m, nf, edges, freeIndex, target, x } = fdm;
  const { normals, wt, lambda, eps, lpScale, lmin = 0, beta = 0, pin = null, pinWeight = 1 } = opts;
  let short = 0;
  if (!fdm.solve(q)) return { J: Infinity };
  // An almost-singular D still "solves" but not accurately: reject on the equilibrium residual.
  if (!(fdm.residual(q).worst < 1e-6 * (opts.loadScale || 1))) return { J: Infinity };
  const gx = new Float64Array(3 * nf);
  let fit = 0;
  const c = 1 / nf;
  for (let i = 0; i < n; i++) {
    const fi = freeIndex[i];
    if (fi < 0) continue;
    const dx = x[3 * i] - target[3 * i], dy = x[3 * i + 1] - target[3 * i + 1], dz = x[3 * i + 2] - target[3 * i + 2];
    const nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2];
    const dn = dx * nx + dy * ny + dz * nz;
    // rim nodes are held in place in every direction so the network keeps covering the surface
    const ci = pin && pin[i] ? c * pinWeight : c;
    const wti = pin && pin[i] ? 1 : wt;
    fit += ci * (wti * (dx * dx + dy * dy + dz * dz) + (1 - wti) * dn * dn);
    gx[3 * fi] = 2 * ci * (wti * dx + (1 - wti) * dn * nx);
    gx[3 * fi + 1] = 2 * ci * (wti * dy + (1 - wti) * dn * ny);
    gx[3 * fi + 2] = 2 * ci * (wti * dz + (1 - wti) * dn * nz);
  }
  let lp = 0;
  const k = lambda * lpScale;
  const l2 = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    const a = edges[2 * e], b = edges[2 * e + 1];
    const ux = x[3 * a] - x[3 * b], uy = x[3 * a + 1] - x[3 * b + 1], uz = x[3 * a + 2] - x[3 * b + 2];
    const s = Math.sqrt(q[e] * q[e] + eps * eps);
    l2[e] = ux * ux + uy * uy + uz * uz;
    lp += s * l2[e];
    const fa = freeIndex[a], fb = freeIndex[b];
    let w = 2 * k * s;
    if (lmin > 0 && l2[e] < lmin * lmin) {
      // short-member penalty: keeps node spacing printable instead of letting nodes merge
      const l = Math.sqrt(l2[e]) + 1e-12, v = 1 - l / lmin;
      short += beta * c * v * v;
      w -= (2 * beta * c * v) / (lmin * l);
    }
    if (fa >= 0) { gx[3 * fa] += w * ux; gx[3 * fa + 1] += w * uy; gx[3 * fa + 2] += w * uz; }
    if (fb >= 0) { gx[3 * fb] -= w * ux; gx[3 * fb + 1] -= w * uy; gx[3 * fb + 2] -= w * uz; }
  }
  const J = fit + k * lp + short;
  if (grad) {
    const mu = fdm.adjoint(gx);
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      const fa = freeIndex[a], fb = freeIndex[b];
      let dot = 0;
      for (let d = 0; d < 3; d++) {
        const u = x[3 * a + d] - x[3 * b + d];
        const dm = (fa >= 0 ? mu[3 * fa + d] : 0) - (fb >= 0 ? mu[3 * fb + d] : 0);
        dot += dm * u;
      }
      const s = Math.sqrt(q[e] * q[e] + eps * eps);
      grad[e] = k * (q[e] / s) * l2[e] - dot;
    }
  }
  return { J, fit, loadPath: lp };
}

/**
 * Starting force densities: ridge least squares for equilibrium on the *target* geometry,
 *   min |A q - p|^2 + alpha |q|^2,   A = equilibrium matrix at the target,
 * solved matrix-free with conjugate gradients on the normal equations.
 */
export function initialForceDensities(fdm, alpha, iters = 400) {
  const { n, m, edges, fixed, target, loads } = fdm;
  const Aq = (q, out) => {
    out.fill(0);
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      for (let k = 0; k < 3; k++) {
        const u = q[e] * (target[3 * a + k] - target[3 * b + k]);
        if (!fixed[a]) out[3 * a + k] += u;
        if (!fixed[b]) out[3 * b + k] -= u;
      }
    }
  };
  const ATr = (r, out) => {
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      let s = 0;
      for (let k = 0; k < 3; k++) s += (target[3 * a + k] - target[3 * b + k]) * ((fixed[a] ? 0 : r[3 * a + k]) - (fixed[b] ? 0 : r[3 * b + k]));
      out[e] = s;
    }
  };
  const p = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) if (!fixed[i]) for (let k = 0; k < 3; k++) p[3 * i + k] = loads[3 * i + k];
  const q = new Float64Array(m), r = new Float64Array(m), d = new Float64Array(m), t3 = new Float64Array(3 * n), Hd = new Float64Array(m);
  ATr(p, r);                      // r = A^T p - (A^T A + alpha) q, q = 0
  d.set(r);
  let rr = r.reduce((s, v) => s + v * v, 0);
  const rr0 = rr;
  for (let it = 0; it < iters && rr > 1e-20 * rr0; it++) {
    Aq(d, t3); ATr(t3, Hd);
    let dHd = 0;
    for (let e = 0; e < m; e++) { Hd[e] += alpha * d[e]; dHd += d[e] * Hd[e]; }
    const a = rr / dHd;
    let rrNew = 0;
    for (let e = 0; e < m; e++) { q[e] += a * d[e]; r[e] -= a * Hd[e]; rrNew += r[e] * r[e]; }
    const beta = rrNew / rr; rr = rrNew;
    for (let e = 0; e < m; e++) d[e] = r[e] + beta * d[e];
  }
  return q;
}
