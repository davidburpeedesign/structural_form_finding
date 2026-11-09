# MORPHXGEN — Visual Language Reference

> Generative footwear, built from human form.
> A computational / additive-manufacturing footwear brand. The aesthetic is
> generative-design tooling — point clouds, strain simulations, voronoi meshes,
> wireframe spheres — rendered light-on-near-black over a CAD-like technical grid.
> Clinical, future-industrial, quietly luxurious. Restraint is the point.

This file is the primary visual language of the system. Drop it into a project as
context; all token values below are authoritative and copy-pasteable.

---

## 1. Voice & content

- **All lowercase, always.** The only capitalized word is the wordmark `MORPHXGEN`.
- **File-handle naming.** Products read like tokens/filenames: `adapt_zer0`,
  `morphxgen™`, `pressure_still`, `test_02j.POINTS.05`. Underscores + version
  numbers are part of the look.
- **Machine-terse status.** One clipped word + ellipsis: `generating...`. UI verbs
  short + lowercase: `add to cart`, `scroll`, `top`.
- **Engineering register** for body copy — declarative, manifesto-like.
  *"Exactly what is needed, and nothing more."*
- **Voice = "we / it", never "you".** Confident, not salesy.
- **No emoji. Ever.**

---

## 2. Color

Near-black void canvas, bone-white ink, exactly **one** UI accent (coral, used like
an indicator light). The data palette appears ONLY inside imagery (heat/pressure
renders), never as UI chrome.

```css
:root {
  /* Base */
  --mx-void:        #222222;  /* primary background        */
  --mx-void-deep:   #1a1a1a;  /* deeper wells / recesses    */
  --mx-void-raise:  #2b2b2b;  /* raised surface / hover     */
  --mx-bone:        #e4e3df;  /* primary off-white ink      */
  --mx-white:       #ffffff;  /* emphasis / signals only    */
  --mx-gray:        #d9d9d9;  /* neutral fill               */

  /* Signal accent — the ONLY accent */
  --mx-coral:       #e48484;  /* active cell, marker, focus */
  --mx-coral-dim:   #b76a6a;  /* pressed / muted            */

  /* Data scheme — imagery only, never UI */
  --mx-data-blue:        #6b95c2;
  --mx-data-indigo:      #4c58ad;
  --mx-data-violet:      #312f4a;
  --mx-data-maroon-deep: #472b31;
  --mx-data-maroon:      #8d3e46;
  --mx-data-amber:       #dd7d56;

  /* Bone alpha ramp — lines, muted text, scrims */
  --mx-bone-04: rgba(228,227,223,0.04);
  --mx-bone-08: rgba(228,227,223,0.08);
  --mx-bone-12: rgba(228,227,223,0.12);
  --mx-bone-16: rgba(228,227,223,0.16);  /* technical grid hairline */
  --mx-bone-24: rgba(228,227,223,0.24);
  --mx-bone-40: rgba(228,227,223,0.40);
  --mx-bone-55: rgba(228,227,223,0.55);
  --mx-bone-72: rgba(228,227,223,0.72);

  /* Semantic aliases — author against THESE, not raws */
  --bg:            var(--mx-void);
  --bg-deep:       var(--mx-void-deep);
  --surface-raise: var(--mx-void-raise);
  --text-primary:  var(--mx-bone);
  --text-emphasis: var(--mx-white);
  --text-muted:    var(--mx-bone-55);
  --text-faint:    var(--mx-bone-40);
  --accent:        var(--mx-coral);
  --accent-press:  var(--mx-coral-dim);
  --line:          var(--mx-bone-16);  /* grid hairlines    */
  --line-soft:     var(--mx-bone-08);
  --line-strong:   var(--mx-bone);     /* full-strength rule */
  --focus-ring:    var(--mx-coral);
}
```

There is **no light mode.**

---

## 3. Typography

Monospace-forward. Three families:

- **Space Mono** — big display only (`adapt_zer0` at 64–96px)
- **Intel One Mono** — workhorse: nav, body, labels, UI, data
- **Montserrat Medium** (`0.10em` tracking) — the `MORPHXGEN` wordmark only

```css
/* Webfont (Google Fonts — actual brand faces, not substitutes) */
@import url("https://fonts.googleapis.com/css2?family=Intel+One+Mono:wght@400;500;600&family=Montserrat:wght@200;300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap");

:root {
  --font-display: "Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --font-mono:    "Intel One Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --font-sans:    "Montserrat", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  --fw-thin: 200; --fw-light: 300; --fw-regular: 400; --fw-medium: 500; --fw-bold: 700;

  /* Scale (px; design built at 1920 canvas) */
  --fs-display-xl: 96px;  /* hero "adapt_zer0"             */
  --fs-display-l:  64px;
  --fs-display-m:  48px;
  --fs-head:       36px;  /* wordmark / section heads      */
  --fs-title:      32px;
  --fs-body-l:     24px;  /* lede / product copy           */
  --fs-ui:         20px;  /* nav, cells, prices, controls  */
  --fs-label:      16px;  /* spec labels, captions         */
  --fs-micro:      14px;  /* fine print                    */

  /* Leading */
  --lh-tight: 1.0;  --lh-snug: 1.15;  --lh-body: 1.45;

  /* Tracking */
  --ls-wordmark: 0.10em;  --ls-ui: 0.04em;  --ls-body: -0.02em;  --ls-display: 0em;
}
```

Display + UI sit on tight 100% leading; body mono opens to ~1.45 with slightly
negative tracking.

---

## 4. Spacing, geometry & motion

CAD-like technical grid. Hairline rules, square corners, corner-tick brackets,
almost no radius, **no drop shadows** — light comes only from screen/lighten
blended renders.

```css
:root {
  /* Spacing (8px base) */
  --sp-0: 0;   --sp-1: 4px;  --sp-2: 8px;   --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px; --sp-8: 64px; --sp-9: 96px;
  --sp-10: 128px; --sp-11: 192px;  /* big section gaps @1920 */

  /* Radius — brand is almost entirely square */
  --radius-0: 0px;       /* default: hard corners        */
  --radius-sm: 2px;      /* size cells, chips            */
  --radius-pill: 999px;  /* spec-icon discs ONLY         */

  /* Borders / hairlines */
  --bw-hair: 1px;        /* technical grid lines         */
  --bw-mark: 2px;        /* chevrons, brackets, strokes  */
  --border-hair: 1px solid var(--line);
  --border-mark: 2px solid var(--line-strong);

  /* Corner-bracket tick — the [  ] frame motif */
  --tick-len: 8px;

  /* Layout */
  --gutter: 48px;  --maxw: 1920px;  --nav-h: 88px;

  /* Motion — sparse, mechanical. No bounce/overshoot. */
  --ease-out:  cubic-bezier(0.22, 1, 0.36, 1);
  --ease-mech: cubic-bezier(0.65, 0, 0.35, 1);  /* signature easing */
  --dur-fast: 120ms;  --dur-med: 240ms;  --dur-slow: 600ms;

  /* Elevation — flat. Faint inset hairlines only. */
  --shadow-none: none;
  --inset-hair: inset 0 0 0 1px var(--line);
}
```

- **Hover** = brighten (bone → white) or reveal coral marker / corner ticks.
- **Press** = shift to dimmer coral `#b76a6a` or 1px nudge. No scale-pop, no glow.
- **Reduced motion** shows the end state.

---

## 5. Shape language & iconography

**Signature shape = the corner-tick bracket** — short L-shaped ticks at the four
corners of a control (size cells, `add to cart`) instead of a full box. Strokes are
crisp 1px hairlines or 2px marks.

The brand ships **no icon font.** Marks are geometric monospace, used like type:
chevron pairs (`scroll ⌄` / `⌃ top`), `+` grid crosshairs, the `™`, and the **X**
logo mark (mirrored blade halves forming an hourglass-X). If functional icons are
ever needed, match the weight: 1.5–2px stroke, square caps, no fill (closest CDN =
Lucide @ `stroke-width:1.5`, flagged as a substitution).

### Micro-glyph library

A set of 64 abstract 64×64 SVG glyphs renders in this exact language — 2px
`currentColor` strokes, square caps, recolorable for web graphics / animation.
Families: radial-burst, rings/apertures, node-mesh, geometric marks, HUD/data,
organic-curved. Draw new marks to match: 64×64 viewBox, `stroke="currentColor"`,
`stroke-width="2"`, `stroke-linecap="square"`, `stroke-linejoin="miter"`,
filled accents via `fill="currentColor" stroke="none"`.

---

## 6. Imagery

No gradients as UI, no flat illustration. Imagery is always a **generative
render** — wireframe point-cloud spheres, voronoi-lattice shoes, anisotropic
pressure maps, foot scans. Composite onto the void with `mix-blend-mode: screen`
(cool renders) or `lighten` (warm), so the render's black fuses into the page and
only the bright structure floats. Cool, technical, high-contrast, occasional warm
coral/amber heat spots.

---

## 7. Components

Reusable React components live under `window.MORPHXGENDesignSystem_fba355`:

| Group | Components |
|-------|-----------|
| brand | `Logo`, `Wordmark` |
| core | `Button`, `CornerFrame`, `Tag` |
| navigation | `NavBar` (+ `NavLink`), `ScrollCue` |
| commerce | `SizeSelector`, `SpecGrid` (+ `SpecCell`) |
| layout | `GridRule`, `RenderFrame` |
| feedback | `StatusReadout` |

---

## Quick rules of thumb

1. Lowercase everything except `MORPHXGEN`.
2. Background is always `#222222`. Ink is `#e4e3df`. One accent: coral `#e48484`.
3. Square corners (radius 0). Frame controls with corner-tick brackets, not boxes.
4. No shadows, no gradients-as-UI, no blur panels, no emoji.
5. Hairline grid rules (`rgba(228,227,223,0.16)`) define layout, not floating cards.
6. Motion is mechanical (`cubic-bezier(0.65,0,0.35,1)`), short, end-state on reduced.
7. Imagery = generative renders, screen/lighten blended onto the void.
