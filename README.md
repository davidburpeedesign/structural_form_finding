# MORPHXGEN form_finder

A browser tool for funicular form-finding of strut networks on a loaded surface, aimed at
additively manufactured (SLS) structures. It takes a triangulated surface carrying a load scalar,
plus point supports, and returns member centrelines as NURBS curves with a diameter for each.

No build step and no server-side code: static files, plain ES modules, one vendored dependency
(three.js, for the 3D view).

The interface follows `morphxgen_visual_language`: void background, bone ink, one coral accent,
monospace type, square corners, corner-tick controls, lowercase copy. Two deliberate departures:
type sits below the 1920-canvas scale because the panel is a dense tool, and unit symbols keep
their case (`MPa`, `N`, `kPa`) because lowercase would change their meaning. The brand fonts load
from Google Fonts; offline, the system monospace is used.

## Run

Browsers will not load ES modules from `file://`, so serve the folder:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

### GitHub Pages

`.github/workflows/pages.yml` runs the tests and publishes the site on every push to `main` or
`claude/exciting-hamilton-qoji84`. It needs one setting, once: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. The site then appears at
<https://davidburpeedesign.github.io/structural_form_finding/>.

```bash
npm test
```

runs the solver tests in Node (no dependencies to install).

## Inputs

| Input | Formats | Notes |
| --- | --- | --- |
| Surface mesh | `.obj`, `.ply` | Triangles or polygons. Units are taken as mm. |
| Load scalar | vertex colour | `v x y z r g b` in OBJ, or `red/green/blue` in PLY. The mean of the three channels is the multiplier, 0 to 1. Without colours the multiplier is 1.0 everywhere. |
| Supports | `.obj` (vertices or points), `.igs` (point entities), `.txt`/`.csv` (`x y z` per line) | Or click on the surface in the viewer. A support off the surface keeps its position and is joined to the nearest part of the network. |

In Rhino, tick **Export vertex colors** in the OBJ options, or export PLY. The example mesh in
`examples/` was exported without colours.

## Method

1. **Network.** The imported triangulation is only a design domain. Nodes are re-sampled on it at
   the chosen spacing (farthest-point sampling by geodesic distance, supports first) and connected
   through the dual of their geodesic Voronoi diagram. Each node carries the load of its own cell:
   scalar × area × pressure, along the load direction.
2. **Force-density solve.** For force densities `q` (force / length, tension positive) the
   equilibrium positions follow from one linear system, `D(q) x = p − D_f(q) x_fixed`. It is
   solved with a banded LDLᵀ factorisation after reverse Cuthill–McKee ordering.
3. **Optimisation.** `q` is adjusted to minimise

   `mean deviation from the surface² + λ · Σ|F|·L + short-member penalty`

   Deviation normal to the surface counts fully and sliding along it counts 10 %; rim nodes are
   held in all directions. `Σ|F|·L` is the load path, proportional to material volume at constant
   stress. Gradients come from an adjoint solve; the optimiser is L-BFGS.
   - *Tension only* / *compression only*: `q` is kept single-signed. Such a network can never
     reach outside the convex hull of its supports.
   - *Tension and compression* (default): signed `q`. Because `D` is then indefinite, a first
     stage alternates least-squares solves for geometry and for `q` with a tightening equilibrium
     penalty; the second stage optimises directly at exact equilibrium from that start.
4. **Sizing.** Solid round struts. Diameter is the largest of the minimum printable diameter,
   the strength requirement `√(4|F| / (π σ / SF))`, and for compression members Euler buckling
   over the member length with the same safety factor.
5. **Curves.** Members above a share of the peak force are *primary*, the rest *secondary*. At
   each node members are paired with the one continuing most nearly straight through; the pairs
   are walked into chains, split at supports and where the turn exceeds the set angle. Each chain
   is interpolated by a clamped cubic B-spline through its nodes.

Material defaults are the datasheet values for Precimid 1174Pro CF in its weakest (Z) build
direction: 36 MPa, 3500 MPa, 1.09 g/cm³, 1.0 mm recommended rod diameter, 2.5 mm minimum opening.
The datasheet gives no compressive strength, so the tensile value is used for both.

## Outputs

- **IGES, splines**: entity 126 curves. Level 1 primary, level 2 secondary, level 3 support
  points. Red is tension, blue compression. The entity label holds the largest diameter on the
  curve, e.g. `D1.45`.
- **IGES, polylines**: the same curves as degree-1 polylines through the nodes.
- **CSV**: one row per curve in IGES order, with peak force, diameters, length and volume.
- **JSON**: nodes, members with force and diameter, reactions, curves with knots and control
  points. Use this to pipe each member at its own diameter.

## Limits

- The result is in equilibrium for the one load case entered. It says nothing about other load
  cases, stiffness, global buckling or fatigue. Check the piped geometry with a frame or solid
  analysis before relying on it.
- A surface is only approximately funicular for given supports, so the network leaves it. The
  results panel reports the deviation; the slider trades it against material.
- Joints are treated as pins. Printed joints are rigid, which helps, but is not accounted for.
- Self-weight is not included.
- Member forces follow the triangulated network, so primary curves can be short or wavy. Rib
  layouts along principal stress lines would be smoother; that is not implemented.
- The network is capped at 1200 nodes.

## Layout

```
index.html, style.css   page
js/app.js               viewer and UI (three.js)
js/worker.js            runs the pipeline off the main thread
js/pipeline.js          end-to-end run and exporters
js/io.js                OBJ, PLY, IGES-point and text parsers
js/mesh.js, network.js  mesh analysis, network generation
js/fdm.js, formfind.js  force-density solve, objective, adjoint gradient, driver
js/mixed.js             alternating solver for mixed tension/compression
js/optimize.js          L-BFGS
js/linalg.js            dense LU, banded LDLᵀ, bandwidth-reducing ordering
js/sizing.js            member diameters
js/splines.js           chaining and B-spline interpolation
js/iges.js              IGES writer
test/                   Node tests
vendor/                 three.js (MIT)
```
