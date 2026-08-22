import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  ELEVATION_LEVELS,
  ELEVATION_LIGHTNESS_STEP,
  elevationBackgroundHex,
  elevationLevelForHex,
  elevationShadowValue,
  elevationVariable,
  MIN_ADJACENT_DELTA,
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
// A bounce recovers to exactly `previous + MIN_ADJACENT_DELTA` in OKLCH space,
// but each endpoint is independently hex-quantized (8-bit sRGB) before a test
// decodes it back to lightness -- this is the slack that independent
// round-off on each side of the delta can introduce. NOT a bound that holds
// near true black: the first representable step off (0,0,0) is a much wider
// jump than 8-bit resolution elsewhere, called out at each site that needs it.
const HEX_QUANTIZATION_TOLERANCE = 0.004;

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
  // hold the ceiling step regardless of mode -- direction is universal now
  // (Amendment 3.2), so both fixtures below share the same darken-when-
  // raised formula. Asserted against resolveElevationStep, not the raw
  // ceiling constant, so this keeps holding even if the built-in palette is
  // retuned and its resolved step shrinks (see the `resolveElevationStep`
  // describe block below for themes where it already does).
  //
  // REPLACES the pre-Amendment-3.5 "lightness strictly decreases level over
  // level" test: with the decayed step ratios [1, 0.7, 0.5], level 3's own
  // increment is ALWAYS `step * 0.5`, which at the ceiling step (0.045) is
  // 0.0225 -- below MIN_ADJACENT_DELTA (0.03) regardless of canvas. Level 3
  // therefore ALWAYS bounces lighter than level 2 for a full-ceiling-step
  // theme; strict descending no longer holds past level 2. The
  // adjacent-delta guarantee (>= MIN_ADJACENT_DELTA, replacing the old
  // "always darker" direction) is the invariant that survives, asserted here
  // and generalized across every built-in theme in the "adjacent-contrast
  // bounce" describe block below.
  const BOUNCE_THEME_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['dark theme (catppuccin-frappe)', darkTheme],
    ['light theme (catppuccin-frappe)', lightTheme],
    ['everforest-dark', everforestDarkTheme],
    ['ayu-mirage', ayuMirageTheme],
  ];

  it.each(BOUNCE_THEME_CASES)(
    'levels 1 and 2 keep descending the canonical decayed shift; level 3 bounces lighter by MIN_ADJACENT_DELTA (%s)',
    (_label, theme) => {
      const step = resolveElevationStep(theme);
      const canvasLightness = oklchOf(theme.tokens.canvas).l;
      const level1 = oklchOf(elevationBackgroundHex(theme, 1)).l;
      const level2 = oklchOf(elevationBackgroundHex(theme, 2)).l;
      const level3 = oklchOf(elevationBackgroundHex(theme, 3)).l;

      // Levels 1 and 2: 0.045 and 0.0315 (step * 1, step * 0.7) both clear
      // MIN_ADJACENT_DELTA, so neither compresses enough to bounce -- the
      // plain undamped sum of decayed increments still describes them
      // exactly (no bounce has fired yet to break from it).
      expect(level1).toBeLessThan(canvasLightness);
      expect(level1).toBeCloseTo(canvasLightness - step, LIGHTNESS_TOLERANCE_DIGITS);
      expect(level2).toBeLessThan(level1);
      expect(level2).toBeCloseTo(canvasLightness - step * 1.7, LIGHTNESS_TOLERANCE_DIGITS);

      // Level 3 bounces: lighter than level 2 (not darker), by MIN_ADJACENT_DELTA.
      expect(level3).toBeGreaterThan(level2);
      expect(Math.abs(level3 - level2 - MIN_ADJACENT_DELTA)).toBeLessThan(
        HEX_QUANTIZATION_TOLERANCE,
      );
    },
  );

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

      // Levels 1 and 2 still match a plain undamped sum of decayed increments
      // (step * 1, then + step * 0.7) -- only level 3 (Amendment 3.5) bounces
      // at the ceiling step; see the bounce-specific assertion below and the
      // "adjacent-contrast bounce" describe block for the general invariant.
      const canvasOklch = oklchOf(theme.tokens.canvas);
      const canonicalShiftByLevel: Readonly<Record<1 | 2, number>> = {
        1: ELEVATION_LIGHTNESS_STEP,
        2: ELEVATION_LIGHTNESS_STEP * 1.7,
      };
      for (const level of [1, 2] as const) {
        const lightness = oklchOf(elevationBackgroundHex(theme, level)).l;
        expect(lightness).toBeCloseTo(
          canvasOklch.l - canonicalShiftByLevel[level],
          LIGHTNESS_TOLERANCE_DIGITS,
        );
      }

      const level2 = oklchOf(elevationBackgroundHex(theme, 2)).l;
      const level3 = oklchOf(elevationBackgroundHex(theme, 3)).l;
      expect(level3).toBeGreaterThan(level2);
      expect(Math.abs(level3 - level2 - MIN_ADJACENT_DELTA)).toBeLessThan(
        HEX_QUANTIZATION_TOLERANCE,
      );
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
    // Softening later rungs (0.7x / 0.5x of the base step) empirically holds
    // the full ceiling step for all three built-in themes here -- it is not
    // a proven general guarantee that no theme's resolved step can ever
    // shrink under the decayed formula. What IS guaranteed is emission/
    // constraint self-consistency: resolveElevationStep's walk and
    // elevationBackgroundHex's emission both derive rungs through the same
    // sequential, bounce-aware ladder (Amendment 3.5), so the two can never
    // drift apart from each other.
    expect(resolveElevationStep(darkTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5); // catppuccin-frappe
    expect(resolveElevationStep(everforestDarkTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);
    expect(resolveElevationStep(ayuMirageTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);
  });

  // (c) A valid imported light-theme shape (#ffffff canvas / #767676 text,
  // ~4.54:1 at rest) that the fixed 0.045 step would have dropped to ~3:1 by
  // level 3. Pre-Amendment-3.5, no step candidate kept every rung above 4.5,
  // so the ramp flattened via step 0. Amendment 3.5 (and its post-review
  // round-tripped-lightness fix) changes WHICH candidate survives here, not
  // the outcome, which is byte-identical (every rung == the canvas): at
  // step 0.03, level 1's ideal candidate (canvas - 0.03) is real-darkening
  // in principle, but canvas is already lightness-clamped at 1 (pure white)
  // and 8-bit hex quantization shaves its round-tripped delta to just under
  // 0.03 (~0.0298) -- so it bounces too, and "bounce lighter" has nowhere to
  // go from white, landing right back on the canvas; levels 2-3 bounce the
  // same way for the same reason. 0.03 is the LARGEST candidate for which
  // this all-bounce-clamp escape hatch applies, so resolveElevationStep now
  // picks it over 0.025 (still viable, just no longer the largest).
  it('flattens the ramp for a valid imported-light theme whose own contrast is marginal, via bounce-clamp at the canvas', () => {
    const importedLight = withText(withCanvas(lightTheme, '#ffffff'), '#767676', '#949494');

    expect(resolveElevationStep(importedLight)).toBeCloseTo(0.03, 5);

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

describe('adjacent-contrast bounce (Amendment 3.5)', () => {
  it('cascades a bounce: level 2 compresses under its predecessor and bounces, then level 3 derives its candidate from the BOUNCED level 2 (not the pre-bounce value)', () => {
    // darkTheme's own canvas hue/chroma at a custom, low lightness. Level 1
    // is a genuine, unbounced darkening. Level 2's IDEAL candidate is NOT
    // floor-clamped in OKLCH terms (it stays positive) -- but this deep in
    // the ramp, 8-bit sRGB quantization is coarse enough (post-review fix:
    // the ladder now compares ROUND-TRIPPED, not ideal, lightness) that its
    // REAL decoded delta from level 1 still lands under MIN_ADJACENT_DELTA,
    // so it bounces anyway. Level 3 then derives its own candidate from
    // level 2's BOUNCED (lighter) value, not the pre-bounce one -- the exact
    // hexes below were confirmed by running the implementation against the
    // real production functions, not hand-derived.
    const canvasOklch = oklchOf(darkTheme.tokens.canvas);
    const deepDarkCanvas = toHex(oklchToRgba({ l: 0.11, c: canvasOklch.c, h: canvasOklch.h }));
    const theme = withText(withCanvas(darkTheme, deepDarkCanvas), '#f5f5f5', '#c8c8c8');

    expect(resolveElevationStep(theme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const canvasHex = elevationBackgroundHex(theme, 0);
    const level1Hex = elevationBackgroundHex(theme, 1);
    const level2Hex = elevationBackgroundHex(theme, 2);
    const level3Hex = elevationBackgroundHex(theme, 3);

    expect(canvasHex).toBe('#03030f');
    expect(level1Hex).toBe('#010006');
    expect(level2Hex).toBe('#02020c');
    expect(level3Hex).toBe('#050513');

    const canvasL = oklchOf(canvasHex).l;
    const level1 = oklchOf(level1Hex).l;
    const level2 = oklchOf(level2Hex).l;
    const level3 = oklchOf(level3Hex).l;

    // Level 1: genuine darkening (canonical direction), no bounce.
    expect(level1).toBeLessThan(canvasL);
    // Level 2 BOUNCES: lighter than level 1, not darker.
    expect(level2).toBeGreaterThan(level1);
    // Level 3 also bounces, lighter than level 2 -- the sequential-fold claim
    // under test: it derives FROM level 2's bounced value. Had it instead
    // re-derived from the pre-bounce level 2 candidate, level 3's own
    // candidate would land somewhere else entirely (a darker rung much
    // closer to level 1), not this hex.
    expect(level3).toBeGreaterThan(level2);
    expect(level3Hex).not.toBe(level2Hex);
  });

  // Themes/fixtures whose rungs are NOT expected to fully bounce-clamp back
  // onto the canvas (the graceful-degradation exception, covered separately
  // by the imported-light-theme and pathological-theme tests above) -- here
  // every adjacent pair should show a REAL, hex-visible delta of at least
  // MIN_ADJACENT_DELTA, whichever direction it falls.
  const NON_DEGENERATE_THEME_CASES: readonly [label: string, theme: PaletteTheme][] = [
    ['catppuccin-frappe (dark)', darkTheme],
    ['catppuccin-frappe (light)', lightTheme],
    ['everforest-dark', everforestDarkTheme],
    ['ayu-mirage', ayuMirageTheme],
    [
      'dark theme, vivid indigo canvas',
      withText(withCanvas(darkTheme, '#101a3a'), '#f5f5f5', '#c8c8c8'),
    ],
    [
      'light theme, vivid red canvas',
      withText(withCanvas(lightTheme, '#f5e5e5'), '#2a0a0a', '#4a1a1a'),
    ],
  ];

  it.each(NON_DEGENERATE_THEME_CASES)(
    'keeps every adjacent-rung delta >= MIN_ADJACENT_DELTA, tolerance for hex quantization (%s)',
    (_label, theme) => {
      const lightnesses = [0, 1, 2, 3].map(
        (level) => oklchOf(elevationBackgroundHex(theme, level)).l,
      );

      for (const level of LEVELS) {
        const current = lightnesses[level] ?? 0;
        const previous = lightnesses[level - 1] ?? 0;
        expect(Math.abs(current - previous)).toBeGreaterThanOrEqual(
          MIN_ADJACENT_DELTA - HEX_QUANTIZATION_TOLERANCE,
        );
      }
    },
  );

  // Post-review fix (2026-08-22, Codex P2): the adjacent-delta check used to
  // compare IDEAL OKLCH lightness values, but `oklchToRgba` clips channels
  // outside the sRGB gamut -- for a saturated canvas the achievable chroma
  // shrinks as lightness shifts toward the ramp's dark end, so an ideal
  // candidate that clears MIN_ADJACENT_DELTA on paper could clip to a REAL
  // emitted color that doesn't. The ladder now round-trips every candidate
  // (and bounce target) through the exact emission path before comparing or
  // chaining it.
  it('keeps every adjacent delta as close to MIN_ADJACENT_DELTA as gamut clipping allows for a saturated canvas (#00005a, the exact shape from the finding), strictly better than the pre-fix computation', () => {
    // #00005a: OKLCH ~{l: 0.211, c: 0.146, h: 264} -- a fully saturated,
    // moderately dark blue. Using darkTheme's own DEFAULT text tokens (no
    // synthetic override needed): this canvas alone is enough to trigger the
    // bug. Pre-fix (verified by direct computation of the old, ideal-only
    // algorithm against this exact canvas), the REAL (decoded) deltas the
    // old code actually emitted were ~0.0215, ~0.0123, ~0.0123 -- every
    // single adjacent pair broke the 0.03 promise, some by nearly half.
    const theme = withCanvas(darkTheme, '#00005a');

    expect(resolveElevationStep(theme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const hexes = [0, 1, 2, 3].map((level) => elevationBackgroundHex(theme, level));
    expect(hexes).toEqual(['#00005a', '#000c63', '#000059', '#000c63']);

    const levels = hexes.map((hex) => oklchOf(hex).l);
    const deltas = LEVELS.map((level) => Math.abs((levels[level] ?? 0) - (levels[level - 1] ?? 0)));

    // Pairs 2 (level 1 -> 2) and 3 (level 2 -> 3): geometry allows clearing
    // the guarantee, and the round-tripped fold delivers it.
    expect(deltas[1]).toBeGreaterThanOrEqual(MIN_ADJACENT_DELTA);
    expect(deltas[2]).toBeGreaterThanOrEqual(MIN_ADJACENT_DELTA);

    // Pair 1 (canvas -> level 1): even the round-tripped BOUNCE target can't
    // fully clear 0.03 at this chroma/hue -- residual clipping, accepted as
    // best-achievable (single bounce attempt, no retry loop).
    expect(deltas[0]).toBeLessThan(MIN_ADJACENT_DELTA);
    expect(deltas[0]).toBeGreaterThan(0.025);

    // Every pair strictly improves on what the pre-fix, ideal-lightness-only
    // ladder actually emitted for this exact canvas.
    const preFixDeltas = [0.0215, 0.0123, 0.0123];
    deltas.forEach((delta, index) => {
      expect(delta).toBeGreaterThan(preFixDeltas[index] ?? 0);
    });
  });

  // Built-in themes are well inside the sRGB gamut at every rung, so the
  // round-tripped-lightness fix should leave them alone -- verified against
  // the exact hexes emitted before this fix (captured by running the
  // pre-fix implementation). A single hex CAN legitimately drift by one
  // 8-bit channel step (asserted via lightness closeness, not byte-for-byte
  // hex equality): every rung past level 1 now derives from its
  // predecessor's own round-tripped (quantized) lightness rather than an
  // idealized float, so a rung with no bounce anywhere in its ancestry can
  // still pick up a sub-0.001 lightness perturbation from that chaining --
  // imperceptible, and never large enough to change a bounce/no-bounce
  // decision for a theme this far from any gamut boundary.
  const PRE_FIX_BUILT_IN_HEXES: ReadonlyMap<string, readonly HexColor[]> = new Map([
    ['catppuccin-frappe', ['#303446', '#25293a', '#1d2132', '#25283a'] as HexColor[]],
    ['everforest-dark', ['#2d353b', '#222a30', '#1b2228', '#22292f'] as HexColor[]],
    ['ayu-mirage', ['#1f2430', '#151925', '#0e121d', '#141924'] as HexColor[]],
  ]);
  const BUILT_IN_UNCHANGED_TOLERANCE = 0.002;

  it.each([...PRE_FIX_BUILT_IN_HEXES.entries()])(
    "leaves %s's ramp lightness unchanged by the round-tripped-lightness fix",
    (themeId, preFixHexes) => {
      const theme = builtInThemes.find((candidate) => candidate.id === themeId);
      if (!theme) throw new Error(`${themeId} missing from builtInThemes fixture`);

      for (const level of [0, 1, 2, 3]) {
        const preFixL = oklchOf(preFixHexes[level] ?? '#000000').l;
        const currentL = oklchOf(elevationBackgroundHex(theme, level)).l;
        expect(Math.abs(currentL - preFixL)).toBeLessThan(BUILT_IN_UNCHANGED_TOLERANCE);
      }
    },
  );
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

  it('resolves the LOWEST level first when a bounce lands a rung on its grandparent-adjacent (non-adjacent) hex', () => {
    // A vivid, dark-on-light-rung fixture where level 3 bounces enough to
    // land back on level 1's exact tone (its grandparent, not its immediate
    // parent), while level 2 stays genuinely distinct -- a NON-adjacent
    // collision. Requires the ceiling step to actually be in play, so text
    // tokens are engineered light-on-dark (verified: resolveElevationStep
    // === 0.045 here). This fixture's hexes are stable across the
    // round-tripped-lightness fix (post-review): its lightness/chroma
    // combination stays comfortably in-gamut at every rung, so the collision
    // it exercises is a genuine bounce-recovery coincidence, not a gamut- or
    // quantization-driven artifact.
    const collisionTheme = withText(withCanvas(darkTheme, '#101a3a'), '#f5f5f5', '#c8c8c8');
    expect(resolveElevationStep(collisionTheme)).toBeCloseTo(ELEVATION_LIGHTNESS_STEP, 5);

    const level1Hex = elevationBackgroundHex(collisionTheme, 1);
    const level2Hex = elevationBackgroundHex(collisionTheme, 2);
    const level3Hex = elevationBackgroundHex(collisionTheme, 3);

    expect(level1Hex).toBe(level3Hex);
    expect(level2Hex).not.toBe(level1Hex);
    expect(elevationLevelForHex(collisionTheme, level1Hex)).toBe(1);
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
