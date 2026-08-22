import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme } from '../themes';

// The tonal ramp has 4 rungs (elevation-0..elevation-3, canvas through the
// topmost island); the shadow ramp only 3 (shadow-1..shadow-3) -- the ground
// rung casts no shadow.
export const ELEVATION_LEVELS = 4;
// Ceiling candidate for the per-theme step -- see resolveElevationStep: the
// actual step used by elevationBackgroundHex can shrink under this (or hit
// 0) when a theme's text tokens can't keep up with it.
export const ELEVATION_LIGHTNESS_STEP = 0.045;

const MIN_ELEVATION_LEVEL = 0;
const MAX_ELEVATION_LEVEL = ELEVATION_LEVELS - 1;
const MIN_SHADOW_LEVEL = 1;

// Amendment 3.2 (2026-08-21, operator-calibrated): raised surfaces are darker
// than their ground in EVERY mode -- the tonal ramp's direction is universal,
// no longer theme-mode-dependent (the original Material-style "dark themes
// lighten as elevation rises" direction is retired).
const ELEVATION_DIRECTION = -1;

const SHADOW_LIGHTNESS_FACTOR = 0.4;
const SHADOW_ALPHA = 0.5;
const SHADOW_OFFSET_STEP = 2;
const SHADOW_BLUR_STEP = 6;

// Depth softening (Amendment 3.4, 2026-08-22): each level's OWN increment
// decays relative to the resolved base step -- level 1 at full strength,
// level 2 at 0.7x, level 3 at 0.5x -- indexed by `level - 1`. Undamped, a
// flat step x level multiply lets the deepest rung drift arbitrarily far
// from the theme's tonal family; decaying later levels keeps the ramp
// visually coherent as depth increases.
const LEVEL_DECAY_RATIOS: readonly number[] = [1, 0.7, 0.5];
// The tonal ramp's cumulative lightness shift never exceeds this, however
// deep or however large the resolved step -- the deepest rung stays inside
// the theme's own tonal family instead of drifting into a cold pit
// unrelated to the theme's palette (operator-calibrated on ayu-mirage).
// Exported so tests can exercise the cap directly with a step larger than
// `resolveElevationStep` would ever resolve to (its candidate ladder tops
// out at `ELEVATION_LIGHTNESS_STEP`, whose full-depth cumulative shift never
// reaches this ceiling in practice: 0.045 * 2.2 = 0.099).
export const CUMULATIVE_SHIFT_CEILING = 0.1;

// Adjacent-contrast bounce (Amendment 3.5, 2026-08-22): decaying per-level
// steps can compress the ΔL between two ADJACENT rungs below what's visually
// distinguishable on a dark ground -- a raised island then drowns in its
// parent's tone even with a shadow. `rungLightnessLadder` guarantees at
// least this much OKLCH lightness delta between rung N and rung N-1; when
// the canonical (darker) candidate would compress below it, rung N bounces
// LIGHTER instead: `L(previous) + MIN_ADJACENT_DELTA`.
export const MIN_ADJACENT_DELTA = 0.03;

// Readability constrains depth (product priority #1): a fixed 0.045 step can
// make elevated rungs unreadable for a theme's own text tokens (measured on
// everforest-dark, ayu-mirage, and a valid imported light-theme shape). The
// per-theme step walks this descending ladder and keeps the first candidate
// that clears both floors below on every rung -- readability never
// sacrificed for depth.
const ELEVATION_STEP_CANDIDATES: readonly number[] = [
  ELEVATION_LIGHTNESS_STEP,
  0.04,
  0.035,
  0.03,
  0.025,
  0.02,
  0.015,
  0.01,
  0.005,
];
const TEXT_CONTRAST_FLOOR = 4.5;
const MUTED_CONTRAST_FLOOR = 3;

function clampElevationLevel(level: number): number {
  return Math.max(MIN_ELEVATION_LEVEL, Math.min(MAX_ELEVATION_LEVEL, level));
}

function clampShadowLevel(level: number): number {
  return Math.max(MIN_SHADOW_LEVEL, Math.min(MAX_ELEVATION_LEVEL, level));
}

function clampLightness(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Theme tokens are authored data, not user input -- a parse failure here is a
// theme bug, same contract as themeTokenHex/themeTokenOklch in colorMap.ts.
// Reimplemented locally rather than imported: colorMap.ts will come to depend
// on this module's variable helpers (Task 3), so this module stays a leaf
// with no dependency back onto colorMap.ts.
function canvasColor(theme: PaletteTheme): RgbaColor {
  const color = parseCssColor(theme.tokens.canvas);
  if (!color) {
    throw new Error(`invalid canvas token color: ${theme.tokens.canvas}`);
  }
  return color;
}

// Round-trips an ideal (l, c, h) triple through the EXACT path a rung is
// actually emitted through -- oklchToRgba (which clips channels that fall
// outside the sRGB gamut) -> hex -> parseCssColor -> rgbaToOklch -- and
// returns both the resulting hex and its decoded lightness. Post-review fix
// (2026-08-22): `rungLightnessLadder`'s adjacent-delta check used to compare
// IDEAL lightness values that were never actually reachable in sRGB for a
// saturated canvas (the achievable chroma at a given hue shrinks near the
// gamut's dark/light wings, so a candidate that clears MIN_ADJACENT_DELTA on
// paper can clip to a real color that doesn't). Chroma and hue are always
// the CALLER's original canvas values here, never a decoded/drifted one --
// only lightness ever varies across rungs (hue/chroma preserved from canvas
// throughout), so re-deriving from a previous rung's real lightness plus the
// canvas's own c/h stays faithful to that invariant.
// `toHex`/`parseCssColor` round-trip integer RGB losslessly, so this is
// exactly what `elevatedRungHex` would independently compute for the same
// (l, c, h) -- returning the hex here directly (rather than recomputing it
// downstream) guarantees the delta check and the emitted color can never
// diverge from a second, independent clip.
function realRung(l: number, c: number, h: number): { hex: HexColor; lightness: number } {
  const hex = toHex(oklchToRgba({ l, c, h }));
  const rgba = parseCssColor(hex);
  if (!rgba) {
    // Unreachable: toHex always emits a well-formed 6-digit hex string that
    // parseCssColor accepts -- a defensive invariant check, not a real
    // failure mode.
    throw new Error(`invalid round-trip hex: ${hex}`);
  }
  return { hex, lightness: rgbaToOklch(rgba).l };
}

/**
 * The tonal ramp's ACTUAL hex for rungs 0..3 -- the ONE source
 * `elevatedRungHex` (emission) and `stepKeepsTextReadable` (the constraint
 * walk `resolveElevationStep` runs) both read through, so a bounce -- and
 * any gamut clipping -- can never show up in emission without also being
 * seen by the readability check.
 *
 * A SEQUENTIAL fold (Amendment 3.5): each rung N's canonical candidate is
 * the decayed step for level N (`step * LEVEL_DECAY_RATIOS[level - 1]`)
 * applied to rung N-1's ACTUAL (real, round-tripped -- see below) lightness,
 * not a canvas-relative closed form, still capped so the total shift from
 * canvas never exceeds `CUMULATIVE_SHIFT_CEILING` and clamped to [0, 1].
 *
 * Every candidate is immediately round-tripped through `realRung` as soon as
 * it's derived (post-review fix), and THAT real lightness -- never the
 * ideal one -- feeds both the adjacent-delta check below and the next
 * rung's derivation: `oklchToRgba` clips channels outside the sRGB gamut, so
 * for a saturated canvas an ideal candidate that clears `MIN_ADJACENT_DELTA`
 * on paper can clip to a real emitted lightness that doesn't. Comparing (and
 * chaining) real values instead means the ladder can never promise a delta
 * the actual emitted colors don't deliver.
 *
 * When that REAL candidate's delta from rung N-1's REAL lightness compresses
 * below `MIN_ADJACENT_DELTA` -- decay, cap, clamp, or clipping all compress
 * it the same way -- rung N BOUNCES lighter instead: the round-tripped
 * `L(N-1) + MIN_ADJACENT_DELTA` (clamped to [0, 1] first). A SINGLE bounce
 * attempt, no retry loop: if clipping ALSO compresses the round-tripped
 * bounce target below the minimum (residual clipping at the bounce's own
 * lightness/chroma combination), that is the best achievable result for this
 * canvas and is accepted as-is -- still deterministic, and never worse than
 * not bouncing at all. A bounced rung derives every later rung in turn, so a
 * bounce at level 2 propagates into level 3's candidate -- level 3 may end
 * up closer to its grandparent's tone (level 1) than to its immediate
 * parent. Pure and deterministic.
 *
 * @example rungLightnessLadder({ l: 0.3, c: 0.02, h: 260 }, 0.045) // level 3's
 * undamped candidate would sit only 0.0225 below level 2, under
 * `MIN_ADJACENT_DELTA`, so it bounces lighter instead (real hexes, not the
 * ideal lightness values -- see realRung).
 */
function rungLightnessLadder(canvasOklch: Oklch, step: number): readonly HexColor[] {
  const { l: canvasLightness, c, h } = canvasOklch;
  const hexes: HexColor[] = [toHex(oklchToRgba(canvasOklch))];
  const lightness: number[] = [canvasLightness];

  for (let level = 1; level <= MAX_ELEVATION_LEVEL; level += 1) {
    const previous = lightness[level - 1] ?? canvasLightness;
    const increment = step * (LEVEL_DECAY_RATIOS[level - 1] ?? 0);
    const shiftSoFar = canvasLightness - previous;
    const cappedShift = Math.min(shiftSoFar + increment, CUMULATIVE_SHIFT_CEILING);
    const idealCandidate = clampLightness(canvasLightness + ELEVATION_DIRECTION * cappedShift);
    const candidate = realRung(idealCandidate, c, h);

    // increment === 0 only when step itself is 0 -- resolveElevationStep's
    // deliberate "no candidate is readable" flatten. There was no darkening
    // attempt to rescue in that case, so bounce must stay silent: every rung
    // stays exactly the canvas, matching the readability check that verified
    // step 0 (not step 0 plus a bounce) against theme text/textMuted.
    const bounces = increment > 0 && Math.abs(candidate.lightness - previous) < MIN_ADJACENT_DELTA;
    if (!bounces) {
      hexes.push(candidate.hex);
      lightness.push(candidate.lightness);
      continue;
    }

    const bounce = realRung(clampLightness(previous + MIN_ADJACENT_DELTA), c, h);
    hexes.push(bounce.hex);
    lightness.push(bounce.lightness);
  }

  return hexes;
}

function elevatedRungHex(canvasOklch: Oklch, step: number, level: number): HexColor {
  const ladder = rungLightnessLadder(canvasOklch, step);
  return ladder[level] ?? toHex(oklchToRgba(canvasOklch));
}

function stepKeepsTextReadable(theme: PaletteTheme, canvasOklch: Oklch, step: number): boolean {
  for (let level = 1; level <= MAX_ELEVATION_LEVEL; level += 1) {
    const rungHex = elevatedRungHex(canvasOklch, step, level);
    const textRatio = contrastRatio(theme.tokens.text, rungHex);
    const mutedRatio = contrastRatio(theme.tokens.textMuted, rungHex);
    if (textRatio === null || textRatio < TEXT_CONTRAST_FLOOR) return false;
    if (mutedRatio === null || mutedRatio < MUTED_CONTRAST_FLOOR) return false;
  }
  return true;
}

/**
 * The per-theme lightness step for the tonal ramp: the largest candidate in
 * a fixed descending ladder (ceiling `ELEVATION_LIGHTNESS_STEP`) for which
 * every rung 1..3 keeps the theme's `text` token at >= 4.5:1 contrast and
 * `textMuted` at >= 3:1 against that rung. Readability constrains depth --
 * if no candidate satisfies both floors on every rung, returns 0: the tonal
 * ramp flattens to the canvas and depth is carried by the shadow ramp alone.
 * Pure and deterministic (fixed ladder, pure inputs); not memoized -- cheap
 * enough that a cache would only add an invalidation story for no benefit.
 */
export function resolveElevationStep(theme: PaletteTheme): number {
  const canvasOklch = rgbaToOklch(canvasColor(theme));

  const step = ELEVATION_STEP_CANDIDATES.find((candidate) =>
    stepKeepsTextReadable(theme, canvasOklch, candidate),
  );

  return step ?? 0;
}

/**
 * The tonal-ramp background for one elevation level, derived purely from the
 * theme's canvas token -- no per-theme surface tokens involved. Level 0 is
 * the canvas verbatim; each level above it shifts OKLCH lightness DOWN from
 * the resolved `resolveElevationStep(theme)` base step, decaying per level
 * (Amendment 3.4: 1.0x / 0.7x / 0.5x for levels 1/2/3) and capped so the
 * cumulative shift never exceeds `CUMULATIVE_SHIFT_CEILING` -- the deepest
 * rung stays inside the theme's own tonal family instead of drifting toward
 * a cold pit unrelated to its palette. Raised surfaces are darker than their
 * ground in every mode (Amendment 3.2), hue and chroma preserved, lightness
 * clamped to [0, 1]. `level` clamps into 0..`ELEVATION_LEVELS - 1`.
 *
 * Adjacent-contrast bounce (Amendment 3.5): when decay/cap/clamp would
 * compress a rung's delta from its immediate predecessor below
 * `MIN_ADJACENT_DELTA`, that rung bounces LIGHTER instead of continuing to
 * darken -- see `rungLightnessLadder`. Strict level-over-level darkening no
 * longer holds; the guarantee is the adjacent delta, not the direction.
 *
 * @example elevationBackgroundHex(darkTheme, 2) // canvas darkened ~1.7 steps
 */
export function elevationBackgroundHex(theme: PaletteTheme, level: number): HexColor {
  const canvas = canvasColor(theme);
  const clampedLevel = clampElevationLevel(level);
  if (clampedLevel === MIN_ELEVATION_LEVEL) return toHex(canvas);

  const canvasOklch = rgbaToOklch(canvas);
  const step = resolveElevationStep(theme);

  return elevatedRungHex(canvasOklch, step, clampedLevel);
}

/**
 * The shadow-ramp `box-shadow` value for one elevation level: offset-y and
 * blur grow with level, colored from the canvas darkened toward black (OKLCH
 * lightness x 0.4) at alpha 0.5 -- the depth accent separating an island
 * from its ground. The color ingredient is always the theme's canvas, never
 * the elevated background, so it stays constant across levels. `level`
 * clamps into 1..`ELEVATION_LEVELS - 1` -- there is no shadow-0.
 *
 * @example elevationShadowValue(theme, 1) // '0 2px 6px rgba(12, 13, 18, 0.5)'
 */
export function elevationShadowValue(theme: PaletteTheme, level: number): string {
  const clampedLevel = clampShadowLevel(level);
  const canvasOklch = rgbaToOklch(canvasColor(theme));
  const shadowColor = oklchToRgba({
    l: canvasOklch.l * SHADOW_LIGHTNESS_FACTOR,
    c: canvasOklch.c,
    h: canvasOklch.h,
  });

  const offsetY = (SHADOW_OFFSET_STEP * clampedLevel).toString();
  const blur = (SHADOW_BLUR_STEP * clampedLevel).toString();
  const color = `rgba(${shadowColor.r.toString()}, ${shadowColor.g.toString()}, ${shadowColor.b.toString()}, ${SHADOW_ALPHA.toString()})`;

  return `0 ${offsetY}px ${blur}px ${color}`;
}

/**
 * The elevation level (0..`ELEVATION_LEVELS - 1`) whose tonal-ramp background
 * exactly matches `hex` for this theme, or `null` when `hex` is not one of
 * the ramp's own derived colors -- e.g. an accent-classified or preserved
 * background never routes through here. Pure and injective in the common
 * case; at a clamped extreme (a near-white canvas in light mode, a
 * near-black one in dark mode) two adjacent levels CAN legitimately render
 * the identical hex once lightness saturates at the [0, 1] bound -- ties
 * resolve first-wins, returning the LOWEST such level. The adjacent-contrast
 * bounce (Amendment 3.5) adds a second collision shape: a bounced rung is
 * derived relative to its immediate predecessor, not the whole ladder, so it
 * can land on the SAME hex as a NON-adjacent rung (its grandparent's tone)
 * without every level in between collapsing too -- still resolved first-wins
 * by this same linear scan, lowest level first.
 *
 * @example elevationLevelForHex(theme, elevationBackgroundHex(theme, 2)) // 2
 */
export function elevationLevelForHex(theme: PaletteTheme, hex: HexColor): number | null {
  for (let level = MIN_ELEVATION_LEVEL; level <= MAX_ELEVATION_LEVEL; level += 1) {
    if (elevationBackgroundHex(theme, level) === hex) return level;
  }
  return null;
}

/** The CSS custom property name for one elevation level's tonal background. */
export function elevationVariable(level: number): string {
  return `--pm-elevation-${clampElevationLevel(level).toString()}`;
}

/** The CSS custom property name for one elevation level's shadow. */
export function shadowVariable(level: number): string {
  return `--pm-shadow-${clampShadowLevel(level).toString()}`;
}
