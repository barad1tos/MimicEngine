import { oklchToRgba, rgbaToOklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme, ThemeTokenName } from '../themes';

// Elevation follows the palette's authored semantic surface ladder. Themes
// own their visual depth; the engine only maps DOM nesting onto those tokens.
const ELEVATION_TOKENS: readonly ThemeTokenName[] = ['canvas', 'surface1', 'surface2', 'surface3'];

export const ELEVATION_LEVELS = ELEVATION_TOKENS.length;

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

function themeColor(theme: PaletteTheme, token: ThemeTokenName): RgbaColor {
  const value = theme.tokens[token];
  const color = parseCssColor(value);
  if (!color) {
    throw new Error(`invalid ${token} token color: ${value}`);
  }
  return color;
}

/** Returns the authored theme color for one clamped elevation level. */
export function elevationBackgroundHex(theme: PaletteTheme, level: number): HexColor {
  const clampedLevel = clampElevationLevel(level);
  const token = ELEVATION_TOKENS[clampedLevel] ?? 'canvas';
  return toHex(themeColor(theme, token));
}

/** Returns the canvas-derived shadow for one clamped elevation level. */
export function elevationShadowValue(theme: PaletteTheme, level: number): string {
  const clampedLevel = clampShadowLevel(level);
  const canvasOklch = rgbaToOklch(themeColor(theme, 'canvas'));
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

/** The CSS custom property name for one elevation level's background. */
export function elevationVariable(level: number): string {
  return `--pm-elevation-${clampElevationLevel(level).toString()}`;
}

/** The CSS custom property name for one elevation level's shadow. */
export function shadowVariable(level: number): string {
  return `--pm-shadow-${clampShadowLevel(level).toString()}`;
}
