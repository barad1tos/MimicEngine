import { describe, expect, it } from 'vitest';
import { rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  ELEVATION_LEVELS,
  ELEVATION_LIGHTNESS_STEP,
  elevationBackgroundHex,
  elevationShadowValue,
  elevationVariable,
  shadowVariable,
} from './elevationScale';

const darkTheme = builtInThemes[0];
const lightTheme: PaletteTheme = { ...darkTheme, mode: 'light' };

const LEVELS: readonly number[] = [1, 2, 3];
const LIGHTNESS_TOLERANCE_DIGITS = 2; // toBeCloseTo(x, 2) ~= |diff| < 0.005
const HUE_TOLERANCE_DEGREES = 1;
const CHROMA_TOLERANCE = 0.005;

function requireColor(value: string): RgbaColor {
  const color = parseCssColor(value);
  if (!color) throw new Error(`bad test color ${value}`);
  return color;
}

function oklchOf(value: string): Oklch {
  return rgbaToOklch(requireColor(value));
}

function withCanvas(theme: PaletteTheme, canvas: string): PaletteTheme {
  return { ...theme, tokens: { ...theme.tokens, canvas } };
}

describe('elevationScale constants', () => {
  it('exposes the ramp size and lightness step the rest of the engine relies on', () => {
    expect(ELEVATION_LEVELS).toBe(4);
    expect(ELEVATION_LIGHTNESS_STEP).toBeCloseTo(0.045, 5);
  });
});

describe('elevationBackgroundHex', () => {
  const THEME_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['dark theme', darkTheme],
    ['light theme', lightTheme],
  ];

  it.each(THEME_CASES)('level 0 returns the canvas hex verbatim (%s)', (_label, theme) => {
    expect(elevationBackgroundHex(theme, 0)).toBe(toHex(requireColor(theme.tokens.canvas)));
  });

  const CLAMP_CASES: readonly [input: number, target: number][] = [
    [-5, 0],
    [0, 0],
    [3, 3],
    [9, 3],
  ];

  it.each(CLAMP_CASES)('clamps level %i into the 0..3 domain (target %i)', (input, target) => {
    expect(elevationBackgroundHex(darkTheme, input)).toBe(
      elevationBackgroundHex(darkTheme, target),
    );
  });

  it('dark theme: lightness strictly increases level over level by the fixed step', () => {
    const canvasLightness = oklchOf(darkTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(darkTheme, level)).l;
      expect(lightness).toBeGreaterThan(previous);
      expect(lightness).toBeCloseTo(
        canvasLightness + ELEVATION_LIGHTNESS_STEP * level,
        LIGHTNESS_TOLERANCE_DIGITS,
      );
      previous = lightness;
    }
  });

  it('light theme: lightness strictly decreases level over level by the fixed step', () => {
    const canvasLightness = oklchOf(lightTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(lightTheme, level)).l;
      expect(lightness).toBeLessThan(previous);
      expect(lightness).toBeCloseTo(
        canvasLightness - ELEVATION_LIGHTNESS_STEP * level,
        LIGHTNESS_TOLERANCE_DIGITS,
      );
      previous = lightness;
    }
  });

  // Hue is degenerate at low chroma (atan2 of two near-zero components), so
  // the built-in themes' fairly grayish canvases are a noisy signal for this
  // assertion -- vivid synthetic canvases make the hue measurement stable
  // enough to hold to a tight tolerance.
  const VIVID_CANVAS_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['dark theme, vivid indigo canvas', withCanvas(darkTheme, '#2a3a8c')],
    ['light theme, vivid red canvas', withCanvas(lightTheme, '#c23b3b')],
  ];

  it.each(VIVID_CANVAS_CASES)(
    'preserves hue and chroma across all levels (%s)',
    (_label, theme) => {
      const canvasOklch = oklchOf(theme.tokens.canvas);

      for (const level of LEVELS) {
        const oklch = oklchOf(elevationBackgroundHex(theme, level));
        expect(Math.abs(oklch.c - canvasOklch.c)).toBeLessThanOrEqual(CHROMA_TOLERANCE);
        expect(Math.abs(oklch.h - canvasOklch.h)).toBeLessThanOrEqual(HUE_TOLERANCE_DEGREES);
      }
    },
  );

  const EXTREME_CANVAS_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['near-white light theme', withCanvas(lightTheme, '#fefefe')],
    ['near-black dark theme', withCanvas(darkTheme, '#010101')],
  ];

  it.each(EXTREME_CANVAS_CASES)(
    'stays finite and in [0, 1] at extreme canvases (%s)',
    (_label, theme) => {
      for (const level of LEVELS) {
        const lightness = oklchOf(elevationBackgroundHex(theme, level)).l;
        expect(Number.isNaN(lightness)).toBe(false);
        expect(lightness).toBeGreaterThanOrEqual(0);
        expect(lightness).toBeLessThanOrEqual(1);
      }
    },
  );

  it('clamps lightness at 1 instead of overshooting (dark theme, white canvas)', () => {
    // Unclamped level-3 target would be 1 + 3 * 0.045 = 1.135, impossible.
    const whiteCanvasDark = withCanvas(darkTheme, '#ffffff');
    const lightness = oklchOf(elevationBackgroundHex(whiteCanvasDark, 3)).l;
    expect(lightness).toBeLessThanOrEqual(1);
    expect(lightness).toBeGreaterThan(0.9);
  });

  it('clamps lightness at 0 instead of undershooting (light theme, black canvas)', () => {
    // Unclamped level-3 target would be 0 - 3 * 0.045 = -0.135, impossible.
    const blackCanvasLight = withCanvas(lightTheme, '#000000');
    const lightness = oklchOf(elevationBackgroundHex(blackCanvasLight, 3)).l;
    expect(lightness).toBeGreaterThanOrEqual(0);
    expect(lightness).toBeLessThan(0.1);
  });
});

describe('elevationShadowValue', () => {
  it.each(LEVELS)('scales offset-y and blur with level %i and is deterministic', (level) => {
    const value = elevationShadowValue(darkTheme, level);

    expect(value).toBe(elevationShadowValue(darkTheme, level));
    expect(value).toMatch(
      new RegExp(
        `^0 ${(2 * level).toString()}px ${(6 * level).toString()}px rgba\\(\\d+, \\d+, \\d+, 0\\.5\\)$`,
      ),
    );
  });

  it('clamps level 0 up to the level-1 shadow and level 4 down to the level-3 shadow', () => {
    expect(elevationShadowValue(darkTheme, 0)).toBe(elevationShadowValue(darkTheme, 1));
    expect(elevationShadowValue(darkTheme, 4)).toBe(elevationShadowValue(darkTheme, 3));
  });

  it('derives shadow color from the canvas, not from the elevated background', () => {
    // Same shadow for every level since the color ingredient is always the
    // canvas token, independent of which elevation rung is casting it.
    const level1Color = /rgba\([^)]+\)/.exec(elevationShadowValue(darkTheme, 1))?.[0];
    const level3Color = /rgba\([^)]+\)/.exec(elevationShadowValue(darkTheme, 3))?.[0];
    expect(level1Color).toBe(level3Color);
  });
});

describe('variable name helpers', () => {
  const ELEVATION_VARIABLE_CASES: readonly [level: number, expected: string][] = [
    [0, '--pm-elevation-0'],
    [1, '--pm-elevation-1'],
    [2, '--pm-elevation-2'],
    [3, '--pm-elevation-3'],
  ];

  it.each(ELEVATION_VARIABLE_CASES)('elevationVariable(%i) -> %s', (level, expected) => {
    expect(elevationVariable(level)).toBe(expected);
  });

  const SHADOW_VARIABLE_CASES: readonly [level: number, expected: string][] = [
    [1, '--pm-shadow-1'],
    [2, '--pm-shadow-2'],
    [3, '--pm-shadow-3'],
  ];

  it.each(SHADOW_VARIABLE_CASES)('shadowVariable(%i) -> %s', (level, expected) => {
    expect(shadowVariable(level)).toBe(expected);
  });
});
