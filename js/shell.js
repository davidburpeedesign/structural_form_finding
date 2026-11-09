// Flat triangular shell elements for the skin: constant-strain membrane + discrete Kirchhoff
// triangle (DKT, Batoz et al. 1980) for bending, with a small drilling stiffness so every node
// keeps six well-posed degrees of freedom and couples directly to the rib beams.
//
// For each triangle the stiffness is  t * Km + t^3 * Kb  (thickness t), so the unit matrices are
// built once and reused while thicknesses are being sized.

const DRILL = 0.03;

function dktB(xi, eta, g, out) {
  // g: { x23, y23, x31, y31, x12, y12, A }.  out: 3 x 9 curvature matrix (row-major)
  const s = 1 - xi - eta;
  const dN = [
    [1 - 4 * s, 4 * xi - 1, 0, 4 * eta, -4 * eta, 4 * s - 4 * xi],
    [1 - 4 * s, 0, 4 * eta - 1, 4 * xi, 4 * s - 4 * eta, -4 * xi],
  ];
  const side = (x, y) => { const l2 = x * x + y * y; return { a: -x / l2, b: (0.75 * x * y) / l2, c: (0.25 * x * x - 0.5 * y * y) / l2, d: -y / l2, e: (0.25 * y * y - 0.5 * x * x) / l2 }; };
  const k4 = side(g.x23, g.y23), k5 = side(g.x31, g.y31), k6 = side(g.x12, g.y12);
  const H = (N) => {
    const [N1, N2, N3, N4, N5, N6] = N;
    const hx = [
      1.5 * (k6.a * N6 - k5.a * N5), k5.b * N5 + k6.b * N6, N1 - k5.c * N5 - k6.c * N6,
      1.5 * (k4.a * N4 - k6.a * N6), k6.b * N6 + k4.b * N4, N2 - k6.c * N6 - k4.c * N4,
      1.5 * (k5.a * N5 - k4.a * N4), k4.b * N4 + k5.b * N5, N3 - k4.c * N4 - k5.c * N5,
    ];
    const hy = [
      1.5 * (k6.d * N6 - k5.d * N5), -N1 + k5.e * N5 + k6.e * N6, -hx[1],
      1.5 * (k4.d * N4 - k6.d * N6), -N2 + k6.e * N6 + k4.e * N4, -hx[4],
      1.5 * (k5.d * N5 - k4.d * N4), -N3 + k4.e * N4 + k5.e * N5, -hx[7],
    ];
    return [hx, hy];
  };
  const [hxX, hyX] = H(dN[0]), [hxE, hyE] = H(dN[1]);
  const f = 1 / (2 * g.A);
  for (let j = 0; j < 9; j++) {
    out[j] = f * (g.y31 * hxX[j] + g.y12 * hxE[j]);
    out[9 + j] = f * (-g.x31 * hyX[j] - g.x12 * hyE[j]);
    out[18 + j] = f * (-g.x31 * hxX[j] - g.x12 * hxE[j] + g.y31 * hyX[j] + g.y12 * hyE[j]);
  }
}

/**
 * Precompute unit stiffness and recovery matrices for every triangle.
 * @returns { nt, tris, area, Km, Kb (18x18 each, global axes), Bm, Bb (3x18, local strains from global dofs) }
 */
export function buildShell(nodes, tris, E, nu) {
  const nt = tris.length / 3;
  const Km = new Float64Array(324 * nt), Kb = new Float64Array(324 * nt), Bm = new Float64Array(54 * nt), Bb = new Float64Array(54 * nt), area = new Float64Array(nt);
  const c0 = E / (1 - nu * nu);
  const C = [c0, c0 * nu, 0, c0 * nu, c0, 0, 0, 0, (c0 * (1 - nu)) / 2];
  const kl = new Float64Array(324), bl = new Float64Array(54), tmp = new Float64Array(324), B9 = new Float64Array(27);
  const P = (i) => [nodes[3 * i], nodes[3 * i + 1], nodes[3 * i + 2]];
  for (let t = 0; t < nt; t++) {
    const p1 = P(tris[3 * t]), p2 = P(tris[3 * t + 1]), p3 = P(tris[3 * t + 2]);
    const a = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], b = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const x2 = Math.hypot(...a), e1 = a.map((v) => v / x2);
    let n = [e1[1] * b[2] - e1[2] * b[1], e1[2] * b[0] - e1[0] * b[2], e1[0] * b[1] - e1[1] * b[0]];
    const nl = Math.hypot(...n); n = n.map((v) => v / nl);
    const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const x3 = b[0] * e1[0] + b[1] * e1[1] + b[2] * e1[2], y3 = b[0] * e2[0] + b[1] * e2[1] + b[2] * e2[2];
    const A = (x2 * y3) / 2; area[t] = A;
    const R = [...e1, ...e2, ...n];
    // ---- membrane (CST): local dofs u,v of node i sit at 6i, 6i+1
    const bi = [-y3, y3, 0], ci = [x3 - x2, -x3, x2];
    bl.fill(0);
    for (let i = 0; i < 3; i++) {
      bl[6 * i] = bi[i] / (2 * A); bl[18 + 6 * i + 1] = ci[i] / (2 * A);
      bl[36 + 6 * i] = ci[i] / (2 * A); bl[36 + 6 * i + 1] = bi[i] / (2 * A);
    }
    kl.fill(0);
    addBtCB(kl, bl, C, A);
    rotateInto(Km, 324 * t, kl, R, tmp);
    rotateB(Bm, 54 * t, bl, R);
    // drilling (unit thickness, lives with the membrane part)
    kl.fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) kl[(6 * i + 5) * 18 + 6 * j + 5] = DRILL * E * A * (i === j ? 1 : -0.5);
    rotateInto(Km, 324 * t, kl, R, tmp, true);
    // ---- bending (DKT): local dofs w, thx, thy of node i sit at 6i+2, 6i+3, 6i+4
    const g = { x23: x2 - x3, y23: -y3, x31: x3, y31: y3, x12: -x2, y12: 0, A };
    kl.fill(0);
    for (const [xi, eta] of [[0.5, 0], [0.5, 0.5], [0, 0.5]]) {
      dktB(xi, eta, g, B9);
      spread(B9, bl);
      addBtCB(kl, bl, C, (2 * A) / 6 / 12); // D = C t^3 / 12
    }
    rotateInto(Kb, 324 * t, kl, R, tmp);
    dktB(1 / 3, 1 / 3, g, B9); spread(B9, bl);
    rotateB(Bb, 54 * t, bl, R);
  }
  return { nt, tris, area, Km, Kb, Bm, Bb, C };
}

function spread(B9, bl) {
  bl.fill(0);
  for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) bl[r * 18 + 6 * i + 2 + k] = B9[r * 9 + 3 * i + k];
}
function addBtCB(k, B, C, w) {
  for (let i = 0; i < 18; i++) {
    const c0 = C[0] * B[i] + C[3] * B[18 + i] + C[6] * B[36 + i], c1 = C[1] * B[i] + C[4] * B[18 + i] + C[7] * B[36 + i], c2 = C[2] * B[i] + C[5] * B[18 + i] + C[8] * B[36 + i];
    if (c0 === 0 && c1 === 0 && c2 === 0) continue;
    for (let j = 0; j < 18; j++) k[i * 18 + j] += w * (c0 * B[j] + c1 * B[18 + j] + c2 * B[36 + j]);
  }
}
/** out[o..] (+)= T^T k T, T = diag of six copies of R. */
function rotateInto(out, o, k, R, tmp, add = false) {
  for (let i = 0; i < 18; i++)
    for (let blk = 0; blk < 6; blk++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let r = 0; r < 3; r++) s += k[i * 18 + 3 * blk + r] * R[3 * r + c];
        tmp[i * 18 + 3 * blk + c] = s;
      }
  for (let blk = 0; blk < 6; blk++)
    for (let c = 0; c < 3; c++)
      for (let j = 0; j < 18; j++) {
        let s = 0;
        for (let r = 0; r < 3; r++) s += R[3 * r + c] * tmp[(3 * blk + r) * 18 + j];
        if (add) out[o + (3 * blk + c) * 18 + j] += s; else out[o + (3 * blk + c) * 18 + j] = s;
      }
}
function rotateB(out, o, B, R) {
  for (let r3 = 0; r3 < 3; r3++)
    for (let blk = 0; blk < 6; blk++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let r = 0; r < 3; r++) s += B[r3 * 18 + 3 * blk + r] * R[3 * r + c];
        out[o + r3 * 18 + 3 * blk + c] = s;
      }
}

/**
 * Membrane forces N (per unit width) and moments M (per unit width) at the centroid of triangle t,
 * from its 18 global nodal displacements, for thickness th. Components xx, yy, xy in the local frame.
 */
export function skinActions(shell, t, u18, th, N, M) {
  const { Bm, Bb, C } = shell;
  const e = [0, 0, 0], k = [0, 0, 0];
  for (let r = 0; r < 3; r++) for (let j = 0; j < 18; j++) { e[r] += Bm[54 * t + r * 18 + j] * u18[j]; k[r] += Bb[54 * t + r * 18 + j] * u18[j]; }
  const d = (th * th * th) / 12;
  for (let r = 0; r < 3; r++) {
    N[r] = th * (C[3 * r] * e[0] + C[3 * r + 1] * e[1] + C[3 * r + 2] * e[2]);
    M[r] = d * (C[3 * r] * k[0] + C[3 * r + 1] * k[1] + C[3 * r + 2] * k[2]);
  }
}

/** Largest von Mises stress of the two faces of a plate of thickness th under N and M. */
export function skinStress(N, M, th) {
  let worst = 0;
  for (const sgn of [1, -1]) {
    const sx = N[0] / th + (sgn * 6 * M[0]) / (th * th), sy = N[1] / th + (sgn * 6 * M[1]) / (th * th), sxy = N[2] / th + (sgn * 6 * M[2]) / (th * th);
    worst = Math.max(worst, Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * sxy * sxy));
  }
  return worst;
}
