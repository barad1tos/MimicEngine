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

const SHADOW_LIGHTNESS_FACTOR = 0.4;
const SHADOW_ALPHA = 0.5;
const SHADOW_OFFSET_STEP = 2;
const SHADOW_BLUR_STEP = 6;

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

function elevatedRungHex(
  canvasOklch: Oklch,
  direction: number,
  step: number,
  level: number,
): HexColor {
  const lightness = clampLightness(canvasOklch.l + direction * step * level);
  return toHex(oklchToRgba({ l: lightness, c: canvasOklch.c, h: canvasOklch.h }));
}

function stepKeepsTextReadable(
  theme: PaletteTheme,
  canvasOklch: Oklch,
  direction: number,
  step: number,
): boolean {
  for (let level = 1; level <= MAX_ELEVATION_LEVEL; level += 1) {
    const rungHex = elevatedRungHex(canvasOklch, direction, step, level);
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
  const direction = theme.mode === 'dark' ? 1 : -1;

  const step = ELEVATION_STEP_CANDIDATES.find((candidate) =>
    stepKeepsTextReadable(theme, canvasOklch, direction, candidate),
  );

  return step ?? 0;
}

/**
 * The tonal-ramp background for one elevation level, derived purely from the
 * theme's canvas token -- no per-theme surface tokens involved. Level 0 is
 * the canvas verbatim; each level above it shifts OKLCH lightness by
 * `resolveElevationStep(theme)` (up to `ELEVATION_LIGHTNESS_STEP`, shrinking
 * or flattening to keep the theme's text readable), direction by theme mode
 * (dark themes lighten as elevation rises, light themes darken), hue and
 * chroma preserved, lightness clamped to [0, 1]. `level` clamps into
 * 0..`ELEVATION_LEVELS - 1`.
 *
 * @example elevationBackgroundHex(darkTheme, 2) // canvas lightened two steps
 */
export function elevationBackgroundHex(theme: PaletteTheme, level: number): HexColor {
  const canvas = canvasColor(theme);
  const clampedLevel = clampElevationLevel(level);
  if (clampedLevel === MIN_ELEVATION_LEVEL) return toHex(canvas);

  const canvasOklch = rgbaToOklch(canvas);
  const direction = theme.mode === 'dark' ? 1 : -1;
  const step = resolveElevationStep(theme);

  return elevatedRungHex(canvasOklch, direction, step, clampedLevel);
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
 * resolve first-wins, returning the LOWEST such level.
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
