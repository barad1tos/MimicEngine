import { oklchToRgba, rgbaToOklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme } from '../themes';

// The tonal ramp has 4 rungs (elevation-0..elevation-3, canvas through the
// topmost island); the shadow ramp only 3 (shadow-1..shadow-3) -- the ground
// rung casts no shadow.
export const ELEVATION_LEVELS = 4;
export const ELEVATION_LIGHTNESS_STEP = 0.045;

const MIN_ELEVATION_LEVEL = 0;
const MAX_ELEVATION_LEVEL = ELEVATION_LEVELS - 1;
const MIN_SHADOW_LEVEL = 1;

const SHADOW_LIGHTNESS_FACTOR = 0.4;
const SHADOW_ALPHA = 0.5;
const SHADOW_OFFSET_STEP = 2;
const SHADOW_BLUR_STEP = 6;

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

/**
 * The tonal-ramp background for one elevation level, derived purely from the
 * theme's canvas token -- no per-theme surface tokens involved. Level 0 is
 * the canvas verbatim; each level above it shifts OKLCH lightness by
 * `ELEVATION_LIGHTNESS_STEP`, direction by theme mode (dark themes lighten as
 * elevation rises, light themes darken), hue and chroma preserved, lightness
 * clamped to [0, 1]. `level` clamps into 0..`ELEVATION_LEVELS - 1`.
 *
 * @example elevationBackgroundHex(darkTheme, 2) // canvas lightened two steps
 */
export function elevationBackgroundHex(theme: PaletteTheme, level: number): HexColor {
  const canvas = canvasColor(theme);
  const clampedLevel = clampElevationLevel(level);
  if (clampedLevel === MIN_ELEVATION_LEVEL) return toHex(canvas);

  const canvasOklch = rgbaToOklch(canvas);
  const direction = theme.mode === 'dark' ? 1 : -1;
  const lightness = clampLightness(
    canvasOklch.l + direction * ELEVATION_LIGHTNESS_STEP * clampedLevel,
  );

  return toHex(oklchToRgba({ l: lightness, c: canvasOklch.c, h: canvasOklch.h }));
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
