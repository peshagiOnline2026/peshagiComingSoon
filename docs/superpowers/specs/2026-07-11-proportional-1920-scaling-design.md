# Proportional 1920 scaling for desktop

**Date:** 2026-07-11
**File touched:** `public/styles.css` (only)

## Problem

The landing page was designed on a 1920px Figma canvas. On narrower desktop
screens (e.g. 1270px laptops) the type and UI render at their full 1920px size,
so the page looks oversized and drifts from the Figma proportions.

Two root causes in the current CSS:

1. **Capped `clamp()` values.** Most type/spacing uses
   `clamp(min, Xvw, max)`. The `max` cap is reached across almost the entire
   desktop range, so values freeze at their 1920 size. Example: `.hero__title`
   is `clamp(2.1rem, 8vw, 88px)` — at both 1920px and 1270px it resolves to
   88px.
2. **Hard-coded px values** (`.notify` 60px, `.notify button` 168×56,
   `.field` 16px, `.icon-btn` 40px, body copy 16px, …) that never scale.

## Goal

On desktop screens from **1920px down to 861px**, render the page as a uniform
proportional scale of the 1920 comp (at 1270px the whole page = 66% of 1920).
Leave the existing **tablet (≤860px)** and **mobile (≤600px)** layouts exactly
as they are today.

## Approach: fluid root font-size + rem

One scaling knob. Make the root font-size track the 1920 canvas on desktop,
and express design lengths relative to it.

```css
html { font-size: 16px; }                      /* base — governs ≤860px */

@media (min-width: 861px) {
  html { font-size: min(16px, 100vw / 120); }  /* 1920 / 16 = 120 */
}
```

- **≥1920px** → locked at 16px (design never balloons on large monitors).
- **1920→861px** → `100vw/120` shrinks linearly (16px → ~7.2px), so everything
  in `rem` scales proportionally.
- **≤860px** → media query doesn't apply, root stays 16px → tablet/mobile
  render byte-for-byte as today.

### Transformation rules

1. **Fixed px length values** in the base rules → convert to `rem` (value ÷ 16).
   Because root is 16px everywhere ≤860px, this is a **no-op** there (identical
   rendered px); on desktop it auto-scales via the fluid root. No duplication.
   - Applies to: `font-size`, `width`, `height`, `min/max-width/height`,
     `padding`, `margin`, `gap`, `top/right/bottom/left`, `border-radius`,
     and the dropdown-caret border-width.
   - **Left in px** (cosmetic micro-values, no visible scaling impact):
     `letter-spacing`, `box-shadow`, `outline`, hover `transform` nudges.
   - **Left as-is** (not design-px): `%`, `vw`, `vh/svh`, `aspect-ratio`,
     unitless `line-height`, `--pad` (already `6.25vw` = 120/19.2, proportional),
     `.container` `max-width: 1920px` (a cap only relevant >1920px).

2. **`clamp(min, Xvw, max)` values** → **keep as-is in the base** (they still
   drive the 601–860px tablet range), and **add a `rem` override inside the new
   `@media (min-width: 861px)` block** equal to the intended 1920 value
   (`max ÷ 16` rem). This replaces their inconsistent `vw` coefficients / frozen
   caps with clean proportional scaling on desktop.

The new `@media (min-width: 861px)` block is appended at the end of the file.
It never overlaps the `max-width: 860px`/`600px` blocks, and being later in
source order it overrides the base rules on desktop.

## Verification

Render `public/index.html` at 1920 / 1440 / 1270 / 861 / 860 / 600px and confirm:
- **1920px** and **≤860px**: visually identical to the current build.
- **1270px**: a clean ~66% scale of the 1920 view; nothing overflows or wraps
  unexpectedly.
- Adversarial audit of the diff: every removed px value accounted for, every
  rem override equals `original ÷ 16`, no clamp left frozen on desktop.

## Trade-offs

- A small size step exists at the exact 860/861px seam (tablet layout below,
  proportional desktop above). Real devices sit far from this width.
- Body copy at 1270px becomes ~10.6px (true 66% of 16px). If ever too small,
  the single knob `100vw / 120` can be relaxed (e.g. `/128`) to scale less
  aggressively.
