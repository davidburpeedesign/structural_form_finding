// Small dense linear algebra. The force-density matrix is symmetric but, once tension and
// compression members are mixed, indefinite - so LU with partial pivoting rather than Cholesky.

/** In-place LU factorisation of a row-major n*n matrix. Returns {lu, piv, n, minPivot, maxPivot}. */
export function luFactor(A, n) {
  const piv = new Int32Array(n);
  let minPivot = Infinity, maxPivot = 0;
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > best) { best = v; p = i; }
    }
    piv[k] = p;
    if (best < minPivot) minPivot = best;
    if (best > maxPivot) maxPivot = best;
    if (best === 0) continue;
    if (p !== k) {
      const rk = k * n, rp = p * n;
      for (let j = 0; j < n; j++) { const t = A[rk + j]; A[rk + j] = A[rp + j]; A[rp + j] = t; }
    }
    const rk = k * n, inv = 1 / A[rk + k];
    for (let i = k + 1; i < n; i++) {
      const ri = i * n;
      const f = A[ri + k] * inv;
      if (f === 0) continue;
      A[ri + k] = f;
      for (let j = k + 1; j < n; j++) A[ri + j] -= f * A[rk + j];
    }
  }
  return { lu: A, piv, n, minPivot, maxPivot };
}

/** Solve for nrhs right-hand sides stored interleaved: B[i*nrhs + c]. Overwrites B. */
export function luSolve(F, B, nrhs) {
  const { lu, piv, n } = F;
  // luFactor swaps whole rows (multipliers included), so all row exchanges are applied first
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) for (let c = 0; c < nrhs; c++) { const t = B[k * nrhs + c]; B[k * nrhs + c] = B[p * nrhs + c]; B[p * nrhs + c] = t; }
  }
  for (let k = 0; k < n; k++)
    for (let i = k + 1; i < n; i++) {
      const f = lu[i * n + k];
      if (f !== 0) for (let c = 0; c < nrhs; c++) B[i * nrhs + c] -= f * B[k * nrhs + c];
    }
  for (let k = n - 1; k >= 0; k--) {
    const d = lu[k * n + k];
    for (let c = 0; c < nrhs; c++) {
      let s = B[k * nrhs + c];
      for (let j = k + 1; j < n; j++) s -= lu[k * n + j] * B[j * nrhs + c];
      B[k * nrhs + c] = s / d;
    }
  }
  return B;
}

/** Solve a small dense system A x = b (copies A). */
export function solveDense(A, b, n) {
  const F = luFactor(Float64Array.from(A), n);
  return luSolve(F, Float64Array.from(b), 1);
}

/** Reverse Cuthill-McKee ordering of an undirected graph given as adjacency lists. Returns perm[new] = old. */
export function reverseCuthillMcKee(adjacency) {
  const n = adjacency.length;
  const order = [], seen = new Uint8Array(n);
  const deg = adjacency.map((a) => a.length);
  const bfs = (start) => {
    const out = [start]; seen[start] = 1;
    for (let h = 0; h < out.length; h++) {
      const nb = adjacency[out[h]].filter((w) => !seen[w]).sort((a, b) => deg[a] - deg[b]);
      for (const w of nb) if (!seen[w]) { seen[w] = 1; out.push(w); } // lists may repeat a neighbour
    }
    return out;
  };
  for (;;) {
    let start = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (start < 0 || deg[i] < deg[start])) start = i;
    if (start < 0) break;
    // pseudo-peripheral start: BFS once, restart from the last node reached
    const first = bfs(start);
    for (const v of first) seen[v] = 0;
    order.push(...bfs(first[first.length - 1]));
  }
  return Int32Array.from(order.reverse());
}

/**
 * Symmetric banded LDL^T without pivoting. Storage: A[i*(bw+1) + (i-j)] for 0 <= i-j <= bw.
 * Exact for definite matrices (single-sign force densities). For indefinite ones it can lose
 * accuracy, which callers detect through the equilibrium residual.
 */
export function bandFactor(A, n, bw) {
  const w = bw + 1;
  let minPivot = Infinity, maxPivot = 0;
  for (let j = 0; j < n; j++) {
    // d_j = a_jj - sum_k l_jk^2 d_k
    let d = A[j * w];
    const k0 = Math.max(0, j - bw);
    for (let k = k0; k < j; k++) { const l = A[j * w + (j - k)]; d -= l * l * A[k * w]; }
    A[j * w] = d;
    const ad = Math.abs(d);
    if (ad < minPivot) minPivot = ad;
    if (ad > maxPivot) maxPivot = ad;
    if (d === 0) continue;
    const iMax = Math.min(n - 1, j + bw);
    for (let i = j + 1; i <= iMax; i++) {
      let s = A[i * w + (i - j)];
      for (let k = Math.max(0, i - bw); k < j; k++) s -= A[i * w + (i - k)] * A[j * w + (j - k)] * A[k * w];
      A[i * w + (i - j)] = s / d;
    }
  }
  return { A, n, bw, minPivot, maxPivot };
}

/** Solve with nrhs interleaved right-hand sides, in place. */
export function bandSolve(F, B, nrhs) {
  const { A, n, bw } = F, w = bw + 1;
  for (let i = 0; i < n; i++)
    for (let k = Math.max(0, i - bw); k < i; k++) {
      const l = A[i * w + (i - k)];
      if (l !== 0) for (let c = 0; c < nrhs; c++) B[i * nrhs + c] -= l * B[k * nrhs + c];
    }
  for (let i = 0; i < n; i++) { const d = A[i * w]; for (let c = 0; c < nrhs; c++) B[i * nrhs + c] /= d; }
  for (let i = n - 1; i >= 0; i--)
    for (let k = Math.max(0, i - bw); k < i; k++) {
      const l = A[i * w + (i - k)];
      if (l !== 0) for (let c = 0; c < nrhs; c++) B[k * nrhs + c] -= l * B[i * nrhs + c];
    }
  return B;
}
