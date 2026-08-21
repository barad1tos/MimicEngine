import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  ELEVATION_LEVELS,
  ELEVATION_LIGHTNESS_STEP,
  elevationBackgroundHex,
  elevationLevelForHex,
  elevationShadowValue,
  elevationVariable,
  resolveElevationStep,
  shadowVariable,
} from './elevationScale';

const darkTheme = builtInThemes[0];
const lightTheme: PaletteTheme = { ...darkTheme, mode: 'light' };
const everforestDarkTheme = builtInThemes.find((theme) => theme.id === 'everforest-dark');
if (!everforestDarkTheme) throw new Error('everforest-dark missing from builtInThemes fixture');

const LEVELS: readonly number[] = [1, 2, 3];
const LIGHTNESS_TOLERANCE_DIGITS = 2; // toBeCloseTo(x, 2) ~= |diff| < 0.005
const HUE_TOLERANCE_DEGREES = 3;
const CHROMA_TOLERANCE = 0.008;
const TEXT_CONTRAST_FLOOR = 4.5;
const MUTED_CONTRAST_FLOOR = 3;

function requireColor(value: string): RgbaColor {
  const color = parseCssColor(value);
  if (!color) throw new Error(`bad test color ${value}`);
  return color;
}

function requireRatio(foreground: string, background: string): number {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null) throw new Error(`unratable contrast pair ${foreground}/${background}`);
  return ratio;
}

function oklchOf(value: string): Oklch {
  return rgbaToOklch(requireColor(value));
}

function withCanvas(theme: PaletteTheme, canvas: string): PaletteTheme {
  return { ...theme, tokens: { ...theme.tokens, canvas } };
}

function withText(theme: PaletteTheme, text: string, textMuted: string): PaletteTheme {
  return { ...theme, tokens: { ...theme.tokens, text, textMuted } };
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

  // catppuccin-frappe (darkTheme/lightTheme's shared token set) happens to
  // hold the ceiling step on both mode directions -- asserted against
  // resolveElevationStep, not the raw ceiling constant, so this keeps
  // holding even if the built-in palette is retuned and its resolved step
  // shrinks (see the `resolveElevationStep` describe block below for themes
  // where it already does).
  it('dark theme: lightness strictly increases level over level by the resolved step', () => {
    const step = resolveElevationStep(darkTheme);
    const canvasLightness = oklchOf(darkTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(darkTheme, level)).l;
      expect(lightness).toBeGreaterThan(previous);
      expect(lightness).toBeCloseTo(canvasLightness + step * level, LIGHTNESS_TOLERANCE_DIGITS);
      previous = lightness;
    }
  });

  it('light theme: lightness strictly decreases level over level by the resolved step', () => {
    const step = resolveElevationStep(lightTheme);
    const canvasLightness = oklchOf(lightTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(lightTheme, level)).l;
      expect(lightness).toBeLessThan(previous);
      expect(lightness).toBeCloseTo(canvasLightness - step * level, LIGHTNESS_TOLERANCE_DIGITS);
      previous = lightness;
    }
  });

  // Hue is degenerate at low chroma (atan2 of two near-zero components), so
  // a vivid canvas is needed for a stable hue measurement -- paired here with
  // text tokens engineered to keep a non-zero resolved step (asserted below),
  // so the shift being measured is real, not a step-0 flatten trivially
  // "preserving" hue and chroma by leaving every rung equal to the canvas.
  const VIVID_CANVAS_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['dark theme, vivid indigo canvas', withCanvas(darkTheme, '#2a3a8c')],
    [
      'light theme, vivid red canvas',
      withText(withCanvas(lightTheme, '#8c2a2a'), '#f5f5f5', '#c8c8c8'),
    ],
  ];

  it.each(VIVID_CANVAS_CASES)(
    'preserves hue and chroma across all levels (%s)',
    (_label, theme) => {
      expect(resolveElevationStep(theme)).toBeGreaterThan(0);
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
    // Text tokens engineered dark-on-white so contrast holds at the ceiling
    // step (verified: resolveElevationStep === 0.045 here) -- the boundary
    // this exercises is the OKLCH lightness clamp, not a step-0 flatten.
    // Unclamped level-3 target would be 1 + 3 * 0.045 = 1.135, impossible.
    const whiteCanvasDark = withText(withCanvas(darkTheme, '#ffffff'), '#1a1a1a', '#333333');
    expect(resolveElevationStep(whiteCanvasDark)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const lightness = oklchOf(elevationBackgroundHex(whiteCanvasDark, 3)).l;
    expect(lightness).toBeLessThanOrEqual(1);
    expect(lightness).toBeGreaterThan(0.9);
  });

  it('clamps lightness at 0 instead of undershooting (light theme, black canvas)', () => {
    // Text tokens engineered light-on-black so contrast holds at the ceiling
    // step (verified: resolveElevationStep === 0.045 here) -- the boundary
    // this exercises is the OKLCH lightness clamp, not a step-0 flatten.
    // Unclamped level-3 target would be 0 - 3 * 0.045 = -0.135, impossible.
    const blackCanvasLight = withText(withCanvas(lightTheme, '#000000'), '#f0f0f0', '#cccccc');
    expect(resolveElevationStep(blackCanvasLight)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const lightness = oklchOf(elevationBackgroundHex(blackCanvasLight, 3)).l;
    expect(lightness).toBeGreaterThanOrEqual(0);
    expect(lightness).toBeLessThan(0.1);
  });
});

describe('resolveElevationStep', () => {
  // (a) A theme engineered so every rung keeps both floors clear at the
  // ceiling step -- confirms the candidate walk picks the largest one when
  // nothing constrains it, in both mode directions.
  const GENEROUS_CASES: readonly [label: string, theme: PaletteTheme][] = [
    [
      'dark theme, vivid indigo canvas, dark-on-light-rung text',
      withText(withCanvas(darkTheme, '#101a3a'), '#f5f5f5', '#c8c8c8'),
    ],
    [
      'light theme, vivid red canvas, light-on-dark-rung text',
      withText(withCanvas(lightTheme, '#f5e5e5'), '#2a0a0a', '#4a1a1a'),
    ],
  ];

  it.each(GENEROUS_CASES)(
    'keeps the ceiling step when nothing constrains it (%s)',
    (_label, theme) => {
      expect(resolveElevationStep(theme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

      const canvasOklch = oklchOf(theme.tokens.canvas);
      const direction = theme.mode === 'dark' ? 1 : -1;
      for (const level of LEVELS) {
        const lightness = oklchOf(elevationBackgroundHex(theme, level)).l;
        expect(lightness).toBeCloseTo(
          canvasOklch.l + direction * ELEVATION_LIGHTNESS_STEP * level,
          LIGHTNESS_TOLERANCE_DIGITS,
        );
      }
    },
  );

  // (b) everforest-dark: at the ceiling step, level 3 drops text to ~4.23:1
  // (below the 4.5 floor) -- the resolved step must shrink under 0.045 while
  // keeping every rung readable.
  it('shrinks below the ceiling for everforest-dark, keeping every rung readable', () => {
    const step = resolveElevationStep(everforestDarkTheme);
    expect(step).toBeLessThan(ELEVATION_LIGHTNESS_STEP);
    expect(step).toBeGreaterThan(0);

    for (const level of LEVELS) {
      const rungHex = elevationBackgroundHex(everforestDarkTheme, level);
      expect(requireRatio(everforestDarkTheme.tokens.text, rungHex)).toBeGreaterThanOrEqual(
        TEXT_CONTRAST_FLOOR,
      );
      expect(requireRatio(everforestDarkTheme.tokens.textMuted, rungHex)).toBeGreaterThanOrEqual(
        MUTED_CONTRAST_FLOOR,
      );
    }
  });

  // (c) A valid imported light-theme shape (#ffffff canvas / #767676 text,
  // ~4.54:1 at rest) that the fixed 0.045 step would have dropped to ~3:1 by
  // level 3. No step candidate keeps every rung above 4.5 here, so the ramp
  // flattens -- the theme's own already-marginal contrast is preserved
  // rather than eroded by depth.
  it('flattens the ramp for a valid imported-light theme whose own contrast is marginal', () => {
    const importedLight = withText(withCanvas(lightTheme, '#ffffff'), '#767676', '#949494');

    expect(resolveElevationStep(importedLight)).toBe(0);

    const canvasHex = elevationBackgroundHex(importedLight, 0);
    for (const level of LEVELS) {
      const rungHex = elevationBackgroundHex(importedLight, level);
      expect(rungHex).toBe(canvasHex);
      expect(requireRatio(importedLight.tokens.text, rungHex)).toBeGreaterThanOrEqual(
        TEXT_CONTRAST_FLOOR,
      );
      expect(requireRatio(importedLight.tokens.textMuted, rungHex)).toBeGreaterThanOrEqual(
        MUTED_CONTRAST_FLOOR,
      );
    }
  });

  // (d) A pathological theme whose text is already nearly illegible against
  // its own canvas (no candidate step could possibly help) -- step 0, every
  // rung equals the canvas, and the shadow ramp (which never reads the step)
  // is unaffected.
  it('flattens fully when no candidate passes, leaving the shadow ramp unaffected', () => {
    const pathological = withText(withCanvas(darkTheme, '#303030'), '#333333', '#363636');

    expect(resolveElevationStep(pathological)).toBe(0);

    const canvasHex = elevationBackgroundHex(pathological, 0);
    for (const level of LEVELS) {
      expect(elevationBackgroundHex(pathological, level)).toBe(canvasHex);
    }

    expect(elevationShadowValue(pathological, 1)).toMatch(
      /^0 2px 6px rgba\(\d+, \d+, \d+, 0\.5\)$/,
    );
    expect(elevationShadowValue(pathological, 3)).toMatch(
      /^0 6px 18px rgba\(\d+, \d+, \d+, 0\.5\)$/,
    );
  });

  // (e) Pure and deterministic: two calls against the same theme -- across
  // every built-in theme and every synthetic fixture above -- agree exactly.
  const DETERMINISM_THEMES: readonly PaletteTheme[] = [
    ...builtInThemes,
    lightTheme,
    ...GENEROUS_CASES.map(([, theme]) => theme),
    withText(withCanvas(lightTheme, '#ffffff'), '#767676', '#949494'),
    withText(withCanvas(darkTheme, '#303030'), '#333333', '#363636'),
  ];

  it.each(DETERMINISM_THEMES)('is deterministic for %o', (theme) => {
    expect(resolveElevationStep(theme)).toBe(resolveElevationStep(theme));
    for (const level of LEVELS) {
      expect(elevationBackgroundHex(theme, level)).toBe(elevationBackgroundHex(theme, level));
    }
  });
});

describe('elevationLevelForHex', () => {
  it.each([0, 1, 2, 3])('resolves the level whose ramp hex matches exactly (level %i)', (level) => {
    const hex = elevationBackgroundHex(darkTheme, level);
    expect(elevationLevelForHex(darkTheme, hex)).toBe(level);
  });

  it("returns null for a hex outside the theme's own elevation ramp", () => {
    const foreignHex = toHex(requireColor('#ff00ff'));
    expect(elevationLevelForHex(darkTheme, foreignHex)).toBeNull();
  });

  it('is theme-scoped: the same derived hex need not resolve to the same level in a different theme', () => {
    const level2HexDark = elevationBackgroundHex(darkTheme, 2);
    expect(elevationLevelForHex(lightTheme, level2HexDark)).not.toBe(2);
  });

  it('resolves the LOWEST level first when two (not all) levels clamp to the same hex', () => {
    // Canvas lightness picked so level 1 (canvas + 1 step) stays under 1, but
    // level 2 (canvas + 2 steps) and level 3 (canvas + 3 steps) both
    // overshoot and clamp to the same value -- an adjacent-pair collision,
    // not a collapse of every level, unlike a literal white canvas (where
    // even level 1 already clamps). Requires the ceiling step to actually be
    // in play, so text tokens are engineered dark-on-near-white (verified:
    // resolveElevationStep === 0.045 here) rather than reusing
    // catppuccinFrappe's light-on-dark text, which flattens this fixture to
    // step 0 and collapses every level onto the same hex instead.
    const canvasLightness = 1 - 1.5 * ELEVATION_LIGHTNESS_STEP;
    const nearClampTheme = withText(
      withCanvas(darkTheme, toHex(oklchToRgba({ l: canvasLightness, c: 0, h: 0 }))),
      '#1a1a1a',
      '#333333',
    );
    expect(resolveElevationStep(nearClampTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const level1Hex = elevationBackgroundHex(nearClampTheme, 1);
    const level2Hex = elevationBackgroundHex(nearClampTheme, 2);
    const level3Hex = elevationBackgroundHex(nearClampTheme, 3);

    expect(level2Hex).toBe(level3Hex);
    expect(level1Hex).not.toBe(level2Hex);
    expect(elevationLevelForHex(nearClampTheme, level2Hex)).toBe(2);
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
