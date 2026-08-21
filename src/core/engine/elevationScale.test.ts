import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  CUMULATIVE_SHIFT_CEILING,
  cumulativeElevationShift,
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
const ayuMirageTheme = builtInThemes.find((theme) => theme.id === 'ayu-mirage');
if (!ayuMirageTheme) throw new Error('ayu-mirage missing from builtInThemes fixture');

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

describe('cumulativeElevationShift (Amendment 3.4 depth softening)', () => {
  const DECAY_TOLERANCE_DIGITS = 6;

  it('decays each level relative to the one before it: 1.0x / 0.7x / 0.5x of the base step', () => {
    // A moderate step, well under where the cumulative cap could ever engage
    // (0.03 * 2.2 = 0.066 < CUMULATIVE_SHIFT_CEILING), so the deltas measured
    // here are the decay ratios alone, uncontaminated by the cap.
    const step = 0.03;

    const level1 = cumulativeElevationShift(step, 1);
    const level2 = cumulativeElevationShift(step, 2);
    const level3 = cumulativeElevationShift(step, 3);

    expect(level1).toBeCloseTo(step * 1, DECAY_TOLERANCE_DIGITS);
    expect(level2 - level1).toBeCloseTo(step * 0.7, DECAY_TOLERANCE_DIGITS);
    expect(level3 - level2).toBeCloseTo(step * 0.5, DECAY_TOLERANCE_DIGITS);
  });

  it("stays under the cumulative cap at the ceiling candidate's full depth (0.045 * 2.2 = 0.099)", () => {
    // Confirms the cap is a genuine ceiling, not something the production
    // candidate ladder ever brushes against in practice.
    const fullDepthShift = cumulativeElevationShift(ELEVATION_LIGHTNESS_STEP, 3);
    expect(fullDepthShift).toBeCloseTo(0.099, 5);
    expect(fullDepthShift).toBeLessThan(CUMULATIVE_SHIFT_CEILING);
  });

  it('engages the cumulative cap once a larger base step would exceed it, without touching lower levels', () => {
    // step = 0.05: level 1 (0.05) and level 2 (0.085) both stay under the
    // 0.1 ceiling: only level 3's undamped total (0.11) would cross it, so
    // this is the case where the cap clips the tail rung alone.
    const step = 0.05;

    expect(cumulativeElevationShift(step, 1)).toBeCloseTo(0.05, DECAY_TOLERANCE_DIGITS);
    expect(cumulativeElevationShift(step, 2)).toBeCloseTo(0.085, DECAY_TOLERANCE_DIGITS);
    expect(cumulativeElevationShift(step, 3)).toBe(CUMULATIVE_SHIFT_CEILING);

    // Still strictly increasing across levels even with the cap engaged at
    // the tail -- the cap clips the excess, it doesn't collapse the ramp.
    expect(cumulativeElevationShift(step, 1)).toBeLessThan(cumulativeElevationShift(step, 2));
    expect(cumulativeElevationShift(step, 2)).toBeLessThan(cumulativeElevationShift(step, 3));
  });

  it('clamps an extreme base step to exactly the ceiling', () => {
    expect(cumulativeElevationShift(1, 3)).toBe(CUMULATIVE_SHIFT_CEILING);
  });

  it('is zero at level 0 regardless of step', () => {
    expect(cumulativeElevationShift(0.045, 0)).toBe(0);
    expect(cumulativeElevationShift(1, 0)).toBe(0);
  });

  it('is deterministic for the same step and level', () => {
    expect(cumulativeElevationShift(0.037, 2)).toBe(cumulativeElevationShift(0.037, 2));
    expect(cumulativeElevationShift(1, 3)).toBe(cumulativeElevationShift(1, 3));
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
  // hold the ceiling step regardless of mode -- direction is universal now
  // (Amendment 3.2), so both fixtures below share the same darken-when-
  // raised formula. Asserted against resolveElevationStep, not the raw
  // ceiling constant, so this keeps holding even if the built-in palette is
  // retuned and its resolved step shrinks (see the `resolveElevationStep`
  // describe block below for themes where it already does).
  it('dark theme: lightness strictly decreases level over level by the decayed cumulative shift', () => {
    const step = resolveElevationStep(darkTheme);
    const canvasLightness = oklchOf(darkTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(darkTheme, level)).l;
      expect(lightness).toBeLessThan(previous);
      expect(lightness).toBeCloseTo(
        canvasLightness - cumulativeElevationShift(step, level),
        LIGHTNESS_TOLERANCE_DIGITS,
      );
      previous = lightness;
    }
  });

  it('light theme: lightness strictly decreases level over level by the decayed cumulative shift', () => {
    const step = resolveElevationStep(lightTheme);
    const canvasLightness = oklchOf(lightTheme.tokens.canvas).l;
    let previous = canvasLightness;

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(lightTheme, level)).l;
      expect(lightness).toBeLessThan(previous);
      expect(lightness).toBeCloseTo(
        canvasLightness - cumulativeElevationShift(step, level),
        LIGHTNESS_TOLERANCE_DIGITS,
      );
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

  it('clamps lightness at 0 instead of undershooting (dark theme, near-black canvas)', () => {
    // Amendment 3.2: direction is universal darken now, so every level only
    // ever subtracts lightness -- overshooting past 1 is no longer reachable
    // in any mode, and the sole clamp boundary left is the floor at 0. Text
    // tokens engineered light-on-near-black so contrast holds at the ceiling
    // step (verified: resolveElevationStep === 0.045 here). The canvas has no
    // room left to darken into, so rungs 1..3 all collide at the same floor
    // value -- benign (a full collapse, not just an adjacent-pair one; see
    // the "resolves the LOWEST level first" test below for that narrower
    // case), never NaN, and deterministic across repeated calls.
    const nearBlackCanvasDark = withText(withCanvas(darkTheme, '#020202'), '#f5f5f5', '#c8c8c8');
    expect(resolveElevationStep(nearBlackCanvasDark)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    for (const level of LEVELS) {
      const lightness = oklchOf(elevationBackgroundHex(nearBlackCanvasDark, level)).l;
      expect(Number.isNaN(lightness)).toBe(false);
      expect(lightness).toBeGreaterThanOrEqual(0);
      expect(lightness).toBeLessThan(0.1);
    }

    expect(elevationBackgroundHex(nearBlackCanvasDark, 1)).toBe(
      elevationBackgroundHex(nearBlackCanvasDark, 3),
    );
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
  // nothing constrains it. Direction is universal now (Amendment 3.2), so
  // both fixtures below share the same darken-when-raised formula regardless
  // of theme.mode.
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
      for (const level of LEVELS) {
        const lightness = oklchOf(elevationBackgroundHex(theme, level)).l;
        expect(lightness).toBeCloseTo(
          canvasOklch.l - cumulativeElevationShift(ELEVATION_LIGHTNESS_STEP, level),
          LIGHTNESS_TOLERANCE_DIGITS,
        );
      }
    },
  );

  // (b) everforest-dark and ayu-mirage were the Amendment 3/3.1 motivators:
  // under the retired lighten-in-dark-mode direction, raising elevation
  // LIGHTENED an already-light-text theme's rungs, eroding text contrast --
  // everforest-dark had to shrink its step below the ceiling to stay
  // readable, and ayu-mirage (near-identical canvas/surface tokens) read
  // visually flat regardless. Amendment 3.2 flips the direction to darken
  // universally: darkening a rung INCREASES contrast for light text, so both
  // themes now regain the full ceiling step instead of shrinking.
  it('holds the ceiling step for everforest-dark now that darkening raises light-text contrast', () => {
    const step = resolveElevationStep(everforestDarkTheme);
    expect(step).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

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

  it('regains a wide step for ayu-mirage, pinning the Amendment 3.2 widening', () => {
    // Pinned above 0.015 (well above what the old, shrunk-under-lightening
    // step would have been) so a future regression back to a lightening
    // direction is caught here rather than silently re-flattening the ramp
    // this amendment exists to fix.
    expect(resolveElevationStep(ayuMirageTheme)).toBeGreaterThan(0.015);
  });

  it('re-derives the ceiling step for all three built-in themes under depth softening (Amendment 3.4)', () => {
    // Softening later rungs (0.7x / 0.5x of the base step) only ever makes
    // the constraint walk MORE permissive than the old undamped multiply --
    // it can never shrink a theme's resolved step below what Amendment 3.2
    // already achieved. All three built-in themes hold the full ceiling.
    expect(resolveElevationStep(darkTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5); // catppuccin-frappe
    expect(resolveElevationStep(everforestDarkTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);
    expect(resolveElevationStep(ayuMirageTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);
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
    withText(withCanvas(darkTheme, '#020202'), '#f5f5f5', '#c8c8c8'),
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
    // Amendment 3.2 made lightTheme's ramp byte-identical to darkTheme's --
    // both share the same catppuccin-frappe tokens and direction no longer
    // depends on theme.mode. A theme with genuinely different tokens
    // (everforest-dark) is needed to exercise theme-scoping now.
    const level2HexDark = elevationBackgroundHex(darkTheme, 2);
    expect(elevationLevelForHex(everforestDarkTheme, level2HexDark)).not.toBe(2);
  });

  it('resolves the LOWEST level first when two (not all) levels clamp to the same hex', () => {
    // Amendment 3.2: direction is universal darken now, so the "two but not
    // all collide" boundary sits near a DARK canvas instead of a near-white
    // one (which the old lighten-in-dark-mode direction used to clamp toward
    // 1). Canvas lightness picked so level 1 (canvas - 1 step) stays above 0,
    // but level 2 (canvas - 2 steps) and level 3 (canvas - 3 steps) both
    // undershoot and clamp to the same floor value -- an adjacent-pair
    // collision, not a collapse of every level (see the near-black-canvas
    // clamp test above for that full-collapse case). Requires the ceiling
    // step to actually be in play, so text tokens are engineered
    // light-on-near-black (verified: resolveElevationStep === 0.045 here).
    const canvasLightness = 2.5 * ELEVATION_LIGHTNESS_STEP;
    const nearClampTheme = withText(
      withCanvas(darkTheme, toHex(oklchToRgba({ l: canvasLightness, c: 0, h: 0 }))),
      '#f5f5f5',
      '#c8c8c8',
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
