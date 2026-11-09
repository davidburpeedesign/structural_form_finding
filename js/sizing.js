// Member sizing for solid round struts.
//
// Each member gets the largest of: the printable minimum, the diameter needed for axial stress,
// and (compression only) the diameter needed against Euler buckling between nodes.

// Supplier datasheet values for Precimid 1174Pro CF (SLS). Strength and stiffness use the weakest
// (Z) build direction because strut orientation in the build is not known at this stage.
// The datasheet gives no compressive strength, so the tensile value is used for both.
export const DEFAULT_MATERIAL = {
  name: 'Precimid 1174Pro CF (SLS)',
  strength: 36,      // MPa, tensile, Z
  modulus: 3500,     // MPa, tensile, Z
  density: 1.09,     // g/cm3
  minDiameter: 1.0,  // mm, recommended rod diameter (absolute minimum 0.8)
  minOpening: 2.5,   // mm
  minCell: 3,        // mm (recommended 4)
  safety: 3,
  bucklingK: 1,
};

/**
 * @param force  Float64Array(m) axial forces [N], tension positive
 * @param length Float64Array(m) member lengths [mm]
 * @param mat    { strength [MPa], modulus [MPa], density [g/cm3], minDiameter [mm], safety, bucklingK }
 */
export function sizeMembers(force, length, mat) {
  const m = force.length;
  const sf = mat.safety ?? 3, K = mat.bucklingK ?? 1;
  const sigma = mat.strength / sf;
  const diameter = new Float64Array(m);
  const governs = new Uint8Array(m); // 0 = minimum gauge, 1 = strength, 2 = buckling
  let volume = 0, nMin = 0, nStrength = 0, nBuckling = 0, fT = 0, fC = 0;
  for (let e = 0; e < m; e++) {
    const f = force[e], a = Math.abs(f);
    let d = mat.minDiameter, g = 0;
    const dS = Math.sqrt((4 * a) / (Math.PI * sigma));
    if (dS > d) { d = dS; g = 1; }
    if (f < 0) {
      // Euler: P_cr = pi^2 E I / (K L)^2, I = pi d^4 / 64, with the same safety factor on load
      const dB = Math.pow((64 * a * sf * (K * length[e]) ** 2) / (Math.PI ** 3 * mat.modulus), 0.25);
      if (dB > d) { d = dB; g = 2; }
      fC = Math.max(fC, a);
    } else fT = Math.max(fT, a);
    diameter[e] = d; governs[e] = g;
    if (g === 0) nMin++; else if (g === 1) nStrength++; else nBuckling++;
    volume += (Math.PI * d * d * length[e]) / 4;
  }
  return { diameter, governs, volume, mass: (volume / 1000) * mat.density, nMin, nStrength, nBuckling, maxTension: fT, maxCompression: fC, allowable: sigma };
}
