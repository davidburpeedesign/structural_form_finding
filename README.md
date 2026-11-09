# MORPHXGEN form_finder

A browser tool that lays out and sizes a rib network on a loaded surface, aimed at additively
manufactured (SLS) shells. It takes a triangulated surface carrying a load scalar, plus point
supports, and returns curves on that surface with a rib depth and width along each.

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

## Methods

Both start the same way. The imported triangulation is only a design domain: nodes are re-sampled
on it at the chosen spacing (farthest-point sampling by geodesic distance, supports first) and
connected through the dual of their geodesic Voronoi diagram. Each node carries the load of its
own cell: scalar × area × pressure, along the load direction.

### Ribs on surface (default)

The network stays exactly on the design surface. Each member is a rectangular rib hanging below
it (on the side the load pushes towards): width in the surface, depth along the normal.

1. **Frame analysis.** The network is solved as a rigid-jointed 3D frame of Euler–Bernoulli beams
   (6 degrees of freedom per node, banded LDLᵀ). Supports are pinned.
2. **Sizing.** Each rib is resized for its own axial force and bending moments so that
   `|N|/(bh) + 6·My/(bh²) + 6·Mz/(hb²)` meets 90 % of the allowable stress. Depth grows first,
   width follows at `depth / max ratio`; at the depth limit the width grows instead. Compression
   ribs are also checked for Euler buckling over their own length. Analysis and sizing repeat
   until the sections settle, then closing passes only let sections grow.
3. **Curves.** Ribs clearly deeper than the minimum are *primary*. Members are chained into
   curves as below. Every curve carries a depth and width at each node, and a second curve: its
   lower edge, the nodes moved below the surface by the depth.

### Funicular net

The original free-form method: members are axial only, and the nodes move to find equilibrium,
so the result leaves the surface.

1. **Force-density solve.** For force densities `q` (force / length, tension positive) the
   equilibrium positions follow from one linear system, `D(q) x = p − D_f(q) x_fixed`.
2. **Optimisation.** `q` is adjusted to minimise
   `mean deviation from the surface² + λ · Σ|F|·L + short-member penalty`, with adjoint gradients
   and L-BFGS. Single-sign modes can never reach outside the convex hull of the supports; the
   mixed mode starts from an alternating least-squares stage because `D` is then indefinite.
3. **Sizing.** Solid round struts: the largest of the minimum diameter, the strength requirement
   and Euler buckling.

### Curves (both methods)

At each node members are paired with the one continuing most nearly straight through; the pairs
are walked into chains, split at supports and where the turn exceeds the set angle. Each chain
is interpolated by a clamped cubic B-spline through its nodes.

Material defaults are the datasheet values for Precimid 1174Pro CF in its weakest (Z) build
direction: 36 MPa, 3500 MPa, 1.09 g/cm³, 1.0 mm recommended rod diameter, 2.5 mm minimum opening.
The datasheet gives no compressive strength, so the tensile value is used for both.

## Outputs

- **IGES, splines**: entity 126 curves. Level 1 primary, level 2 secondary, level 3 support
  points. Red is axial tension, blue compression. For ribs, levels 4 and 5 hold the lower edge of
  each primary and secondary rib in the same order; lofting a surface curve to its lower edge
  gives the rib's mid-plane. Labels: `H` largest depth, `W` largest width (`D` diameter for the
  funicular net).
- **IGES, polylines**: the same curves as degree-1 polylines through the nodes.
- **CSV**: one row per curve in IGES order. For ribs it includes the depth at every node.
- **JSON**: nodes, members with force, moment, width and depth, curves with knots, control
  points and per-node depths.

## Limits

- One load case, linear elastic, small deflections. No global buckling or fatigue check.
- Ribs-only model: there is no skin. Load is lumped at the nodes; a real part needs something
  to collect pressure between ribs. A skin option (off / full / auto) is the planned next stage.
- Rib centrelines are modelled on the surface, not half a depth below it, and shear stress is
  not included in sizing.
- Curves follow the triangulated network, so they can be short or wavy. Laying ribs along
  principal stress lines from a shell analysis is planned.
- Curves pass through nodes on the surface; between nodes a spline can leave it by the sag of
  one node spacing over the local curvature.
- Self-weight is not included. Joints of the funicular net are treated as pins.
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
js/frame.js             3D frame analysis and rib sizing
js/sizing.js            strut diameters (funicular net)
js/splines.js           chaining and B-spline interpolation
js/iges.js              IGES writer
test/                   Node tests
vendor/                 three.js (MIT)
```
