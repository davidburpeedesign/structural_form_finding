// Mixed tension/compression form-finding by alternating least squares.
//
// With signed force densities the FDM matrix D(q) is indefinite and often close to singular, so
// eliminating the geometry (x = D^-1 b) is unreliable. Here geometry x and force densities q are
// both unknowns and nodal equilibrium is enforced by a penalty that is tightened progressively:
//
//   F(x, q) = sum_i c_i |x_i - t_i|^2_W  +  k sum_e |q_e| l_e(x)^2  +  rho sum_i |r_i(x, q)|^2
//   r_i = sum_e q_e (x_i - x_j) - p_i                       (out-of-balance force at free node i)
//
// F is quadratic in x for fixed q and (after reweighting the |q| term) quadratic in q for fixed
// x, so each half-step is a well-posed linear solve: banded SPD for x, conjugate gradients for q.

import { bandFactor, bandSolve } from './linalg.js';

export function alternatingSolve(fdm, q0, opts, { outer = 300, rhoMax = 1e4, onIter = null } = {}) {
  const { n, m, nf, edges, freeIndex, target, loads, fixed } = fdm;
  const { normals, wt, lambda, eps, lpScale, pin, pinWeight = 1, lmin = 0, beta = 0 } = opts;
  const k = lambda * lpScale, c0 = 1 / nf;
  const B = 2 * fdm.bw, w = B + 1;
  const x = Float64Array.from(target);
  const q = Float64Array.from(q0);
  const M = new Float64Array(nf * w), rhs = new Float64Array(3 * nf);
  const inc = Array.from({ length: n }, () => []);
  for (let e = 0; e < m; e++) { inc[edges[2 * e]].push(e); inc[edges[2 * e + 1]].push(e); }
  const add = (i, j, v) => { if (i >= j) M[i * w + (i - j)] += v; };

  const residual = (out) => {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      let rx = -loads[3 * i], ry = -loads[3 * i + 1], rz = -loads[3 * i + 2];
      for (const e of inc[i]) {
        const j = edges[2 * e] === i ? edges[2 * e + 1] : edges[2 * e];
        rx += q[e] * (x[3 * i] - x[3 * j]); ry += q[e] * (x[3 * i + 1] - x[3 * j + 1]); rz += q[e] * (x[3 * i + 2] - x[3 * j + 2]);
      }
      if (out) { out[3 * i] = rx; out[3 * i + 1] = ry; out[3 * i + 2] = rz; }
      worst = Math.max(worst, Math.hypot(rx, ry, rz));
    }
    return worst;
  };

  // ---- x half-step ------------------------------------------------------------------------------
  const cols = [], vals = [];
  const stepX = (rho) => {
    M.fill(0); rhs.fill(0);
    for (let i = 0; i < n; i++) {
      const fi = freeIndex[i];
      if (fi < 0) continue;
      // fit term (majorised so the three coordinates share one matrix)
      const pinned = pin && pin[i];
      const ci = pinned ? c0 * pinWeight : c0, wti = pinned ? 1 : wt;
      const dx = x[3 * i] - target[3 * i], dy = x[3 * i + 1] - target[3 * i + 1], dz = x[3 * i + 2] - target[3 * i + 2];
      const dn = dx * normals[3 * i] + dy * normals[3 * i + 1] + dz * normals[3 * i + 2];
      M[fi * w] += ci;
      rhs[3 * fi] += ci * (target[3 * i] + (1 - wti) * (dx - dn * normals[3 * i]));
      rhs[3 * fi + 1] += ci * (target[3 * i + 1] + (1 - wti) * (dy - dn * normals[3 * i + 1]));
      rhs[3 * fi + 2] += ci * (target[3 * i + 2] + (1 - wti) * (dz - dn * normals[3 * i + 2]));
      // equilibrium row of node i:  sum_cols vals * x + const
      cols.length = 0; vals.length = 0;
      let diag = 0, kx = -loads[3 * i], ky = -loads[3 * i + 1], kz = -loads[3 * i + 2];
      for (const e of inc[i]) {
        const j = edges[2 * e] === i ? edges[2 * e + 1] : edges[2 * e], fj = freeIndex[j];
        diag += q[e];
        if (fj >= 0) { cols.push(fj); vals.push(-q[e]); }
        else { kx -= q[e] * x[3 * j]; ky -= q[e] * x[3 * j + 1]; kz -= q[e] * x[3 * j + 2]; }
      }
      cols.push(fi); vals.push(diag);
      for (let a = 0; a < cols.length; a++) {
        const va = rho * vals[a];
        rhs[3 * cols[a]] -= va * kx; rhs[3 * cols[a] + 1] -= va * ky; rhs[3 * cols[a] + 2] -= va * kz;
        for (let b = 0; b < cols.length; b++) add(cols[a], cols[b], va * vals[b]);
      }
    }
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1], fa = freeIndex[a], fb = freeIndex[b];
      // load-path term k |q| l^2, plus a spring towards lmin for members that are too short
      let s = k * Math.sqrt(q[e] * q[e] + eps * eps);
      let ux = 0, uy = 0, uz = 0, sp = 0;
      if (lmin > 0) {
        ux = x[3 * a] - x[3 * b]; uy = x[3 * a + 1] - x[3 * b + 1]; uz = x[3 * a + 2] - x[3 * b + 2];
        const l = Math.hypot(ux, uy, uz) + 1e-12;
        if (l < lmin) { sp = (beta * c0) / (lmin * lmin); const f = (sp * lmin) / l; ux *= f; uy *= f; uz *= f; }
      }
      const g = s + sp;
      if (fa >= 0) { M[fa * w] += g; if (sp) { rhs[3 * fa] += ux; rhs[3 * fa + 1] += uy; rhs[3 * fa + 2] += uz; } }
      if (fb >= 0) { M[fb * w] += g; if (sp) { rhs[3 * fb] -= ux; rhs[3 * fb + 1] -= uy; rhs[3 * fb + 2] -= uz; } }
      if (fa >= 0 && fb >= 0) add(Math.max(fa, fb), Math.min(fa, fb), -g);
      else if (fa >= 0) for (let d = 0; d < 3; d++) rhs[3 * fa + d] += g * x[3 * b + d];
      else if (fb >= 0) for (let d = 0; d < 3; d++) rhs[3 * fb + d] += g * x[3 * a + d];
    }
    bandSolve(bandFactor(M, nf, B), rhs, 3);
    for (let i = 0; i < n; i++) { const fi = freeIndex[i]; if (fi >= 0) for (let d = 0; d < 3; d++) x[3 * i + d] = rhs[3 * fi + d]; }
  };

  // ---- q half-step: (rho A^T A + diag(wq)) q = rho A^T p, by warm-started CG ---------------------
  const t3 = new Float64Array(3 * n), r = new Float64Array(m), d = new Float64Array(m), Hd = new Float64Array(m), wq = new Float64Array(m);
  const Aq = (v, out) => {
    out.fill(0);
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      for (let c = 0; c < 3; c++) { const u = v[e] * (x[3 * a + c] - x[3 * b + c]); if (!fixed[a]) out[3 * a + c] += u; if (!fixed[b]) out[3 * b + c] -= u; }
    }
  };
  const ATr = (v, out) => {
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      let s = 0;
      for (let c = 0; c < 3; c++) s += (x[3 * a + c] - x[3 * b + c]) * ((fixed[a] ? 0 : v[3 * a + c]) - (fixed[b] ? 0 : v[3 * b + c]));
      out[e] = s;
    }
  };
  const stepQ = (rho, iters) => {
    for (let e = 0; e < m; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      const l2 = (x[3 * a] - x[3 * b]) ** 2 + (x[3 * a + 1] - x[3 * b + 1]) ** 2 + (x[3 * a + 2] - x[3 * b + 2]) ** 2;
      wq[e] = (k * l2) / (2 * Math.sqrt(q[e] * q[e] + eps * eps)) + 1e-9;
    }
    // r = rho A^T (p - A q) - wq q
    Aq(q, t3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t3[3 * i + c] = fixed[i] ? 0 : loads[3 * i + c] - t3[3 * i + c];
    ATr(t3, r);
    let rr = 0;
    for (let e = 0; e < m; e++) { r[e] = rho * r[e] - wq[e] * q[e]; d[e] = r[e]; rr += r[e] * r[e]; }
    const rr0 = rr;
    for (let it = 0; it < iters && rr > 1e-16 * rr0 && rr > 0; it++) {
      Aq(d, t3); ATr(t3, Hd);
      let dHd = 0;
      for (let e = 0; e < m; e++) { Hd[e] = rho * Hd[e] + wq[e] * d[e]; dHd += d[e] * Hd[e]; }
      if (!(dHd > 0)) break;
      const al = rr / dHd;
      let rrN = 0;
      for (let e = 0; e < m; e++) { q[e] += al * d[e]; r[e] -= al * Hd[e]; rrN += r[e] * r[e]; }
      const be = rrN / rr; rr = rrN;
      for (let e = 0; e < m; e++) d[e] = r[e] + be * d[e];
    }
  };

  // ---- continuation in rho -----------------------------------------------------------------------
  let rho = 1;
  const growth = Math.pow(rhoMax, 1 / (0.8 * outer));
  for (let it = 0; it < outer; it++) {
    stepQ(rho, 40);
    stepX(rho);
    rho = Math.min(rhoMax, rho * growth);
    if (onIter && onIter(it + 1, outer) === false) break;
  }
  stepQ(rho, 200);
  return { x, q, residual: residual(null) };
}
