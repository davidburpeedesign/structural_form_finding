// L-BFGS with Armijo backtracking. fn(x, grad) returns the objective (Infinity = infeasible point).

export function lbfgs(fn, x0, { maxIter = 200, history = 12, gtol = 1e-7, ftol = 1e-9, onIter = null } = {}) {
  const n = x0.length;
  let x = Float64Array.from(x0), g = new Float64Array(n);
  let f = fn(x, g);
  if (!Number.isFinite(f)) throw new Error('Optimiser: starting point is infeasible.');
  const S = [], Y = [], RHO = [];
  const d = new Float64Array(n), xn = new Float64Array(n);
  let gn = new Float64Array(n);
  let iter = 0, stall = 0;
  for (; iter < maxIter; iter++) {
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm = Math.max(gnorm, Math.abs(g[i]));
    if (gnorm < gtol) break;
    // two-loop recursion
    for (let i = 0; i < n; i++) d[i] = -g[i];
    const k = S.length, al = new Float64Array(k);
    for (let j = k - 1; j >= 0; j--) {
      let s = 0; for (let i = 0; i < n; i++) s += S[j][i] * d[i];
      al[j] = RHO[j] * s;
      for (let i = 0; i < n; i++) d[i] -= al[j] * Y[j][i];
    }
    if (k > 0) {
      let sy = 0, yy = 0;
      for (let i = 0; i < n; i++) { sy += S[k - 1][i] * Y[k - 1][i]; yy += Y[k - 1][i] * Y[k - 1][i]; }
      const gamma = sy / yy;
      for (let i = 0; i < n; i++) d[i] *= gamma;
    }
    for (let j = 0; j < k; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += Y[j][i] * d[i];
      const b = RHO[j] * s;
      for (let i = 0; i < n; i++) d[i] += (al[j] - b) * S[j][i];
    }
    let gd = 0;
    for (let i = 0; i < n; i++) gd += g[i] * d[i];
    if (!(gd < 0)) { for (let i = 0; i < n; i++) d[i] = -g[i]; gd = 0; for (let i = 0; i < n; i++) gd -= g[i] * g[i]; S.length = Y.length = RHO.length = 0; }
    // first step: scale so the largest change is modest
    let t = 1;
    if (k === 0) { let dm = 0, xm = 0; for (let i = 0; i < n; i++) { dm = Math.max(dm, Math.abs(d[i])); xm = Math.max(xm, Math.abs(x[i])); } t = Math.min(1, (0.05 * (xm || 1)) / (dm || 1)); }
    let fnew = Infinity, ok = false;
    for (let ls = 0; ls < 30; ls++) {
      for (let i = 0; i < n; i++) xn[i] = x[i] + t * d[i];
      fnew = fn(xn, gn);
      if (Number.isFinite(fnew) && fnew <= f + 1e-4 * t * gd) { ok = true; break; }
      t *= 0.5;
    }
    if (!ok) { if (S.length) { S.length = Y.length = RHO.length = 0; continue; } break; }
    const s = new Float64Array(n), y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) { s[i] = xn[i] - x[i]; y[i] = gn[i] - g[i]; sy += s[i] * y[i]; }
    if (sy > 1e-14) { S.push(s); Y.push(y); RHO.push(1 / sy); if (S.length > history) { S.shift(); Y.shift(); RHO.shift(); } }
    const rel = (f - fnew) / Math.max(1e-30, Math.abs(f));
    x.set(xn); const tmp = g; g = gn; gn = tmp; f = fnew;
    if (onIter && onIter(iter, f) === false) break;
    stall = rel < ftol ? stall + 1 : 0;
    if (stall >= 5) break;
  }
  return { x, f, iter };
}
