import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../color/contrast';
import { oklchToRgba, rgbaToOklch } from '../../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../../color/parseColor';
import { THEME_TOKEN_NAMES } from '../themeTypes';
import { deriveGaps } from './derive';
import type { ThemeSlots } from './importTypes';

const LADDER_CANVAS = '#1f2430';
const LADDER_TEXT = '#cbccc6';
// Low-chroma accent whose reference-hue round-trip stays within a fraction
// of a degree at every status hue (145/85/25) — see task report for how it
// was picked. Used as a plain accent source so tests that only care about
// the surface ladder / mode / primaries don't also have to supply ANSI data.
const STABLE_ACCENT = '#a89050';

function baseSlots(overrides: Partial<ThemeSlots> = {}): ThemeSlots {
  return {
    name: 'Test Theme',
    sourceFormat: 'iterm',
    tokens: {},
    ...overrides,
  };
}

function parseOrThrow(hex: string): RgbaColor {
  const rgba = parseCssColor(hex);
  if (!rgba) throw new Error(`test fixture has invalid color: ${hex}`);
  return rgba;
}

function ansiWithBlue(dim: string | undefined, bright: string | undefined): (string | undefined)[] {
  const ansi = new Array<string | undefined>(13).fill(undefined);
  ansi[4] = dim;
  ansi[12] = bright;
  return ansi;
}

describe('deriveGaps', () => {
  it('fills the surface ladder, border, and textMuted at the exact span fractions', () => {
    const slots = baseSlots({
      tokens: { accent: STABLE_ACCENT },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);

    const canvasOklch = rgbaToOklch(parseOrThrow(LADDER_CANVAS));
    const textOklch = rgbaToOklch(parseOrThrow(LADDER_TEXT));
    const span = textOklch.l - canvasOklch.l;
    const canvasHex = (fraction: number) =>
      toHex(
        oklchToRgba({ l: canvasOklch.l + fraction * span, c: canvasOklch.c, h: canvasOklch.h }),
      );
    const textHex = (fraction: number) =>
      toHex(oklchToRgba({ l: canvasOklch.l + fraction * span, c: textOklch.c, h: textOklch.h }));

    expect(result.tokens.surface1).toBe(canvasHex(0.08));
    expect(result.tokens.surface2).toBe(canvasHex(0.16));
    expect(result.tokens.surface3).toBe(canvasHex(0.24));
    expect(result.tokens.border).toBe(canvasHex(0.32));
    expect(result.tokens.textMuted).toBe(textHex(0.7));

    // Falsifiable independent of the mirrored math above: a hand-verified
    // exact golden, computed offline via a standalone re-implementation of
    // the OKLCH matrices (not by calling derive.ts or the mirrored formula).
    expect(result.tokens.surface1).toBe('#2a2f3c');

    // Ordering sanity check that doesn't depend on the exact fraction match.
    const surface1L = rgbaToOklch(parseOrThrow(result.tokens.surface1)).l;
    const surface2L = rgbaToOklch(parseOrThrow(result.tokens.surface2)).l;
    expect(surface1L).toBeGreaterThan(canvasOklch.l);
    expect(surface1L).toBeLessThan(surface2L);

    // Everything except the explicitly-sourced accent should be gap-filled,
    // listed in THEME_TOKEN_NAMES order.
    expect(result.derivedTokens).toEqual(THEME_TOKEN_NAMES.filter((name) => name !== 'accent'));
  });

  it('infers dark mode from canvas lightness when no explicit mode is given', () => {
    const slots = baseSlots({
      tokens: { accent: STABLE_ACCENT },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
    expect(result.mode).toBe('dark');
  });

  it('honors an explicit mode over canvas-lightness inference', () => {
    const slots = baseSlots({
      mode: 'light',
      tokens: { accent: STABLE_ACCENT },
      background: LADDER_CANVAS, // dark canvas would otherwise infer 'dark'
      foreground: LADDER_TEXT,
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
    expect(result.mode).toBe('light');
  });

  it('never overwrites a source token, even a deliberately unusual one', () => {
    const slots = baseSlots({
      tokens: { accent: STABLE_ACCENT, surface2: '#ff0000' },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
    expect(result.tokens.surface2).toBe('#ff0000');
    expect(result.derivedTokens).not.toContain('surface2');
  });

  it('picks the higher-contrast ANSI candidate for accent (bright over dim)', () => {
    const slots = baseSlots({
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
      ansi: ansiWithBlue('#4d6a9c', '#8ab4f8'),
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
    expect(result.tokens.accent).toBe('#8ab4f8');
    expect(result.derivedTokens).toContain('accent');
  });

  it('sources link/success/warning/danger from their correct ANSI slot pairs, not a transposed neighbor', () => {
    // Six color families, each dim/bright pair distinct in hue from every
    // other family. magenta (5/13) is a decoy: no rule maps to it, so if an
    // index got transposed (e.g. cyan 6/14 read as magenta 5/13) the
    // affected token's hue would land ~130 degrees off instead of matching.
    const redDim = '#b94642';
    const redBright = '#ff8e86';
    const greenDim = '#278733';
    const greenBright = '#75d079';
    const yellowDim = '#996700';
    const yellowBright = '#e3ae28';
    const blueDim = '#4671b7';
    const blueBright = '#8ab8ff';
    const magentaDim = '#a04c9a';
    const magentaBright = '#ec92e5';
    const cyanDim = '#00858d';
    const cyanBright = '#3aced6';

    const ansi = new Array<string | undefined>(16).fill(undefined);
    ansi[1] = redDim;
    ansi[9] = redBright;
    ansi[2] = greenDim;
    ansi[10] = greenBright;
    ansi[3] = yellowDim;
    ansi[11] = yellowBright;
    ansi[4] = blueDim;
    ansi[12] = blueBright;
    ansi[5] = magentaDim;
    ansi[13] = magentaBright;
    ansi[6] = cyanDim;
    ansi[14] = cyanBright;

    const slots = baseSlots({ background: LADDER_CANVAS, foreground: LADDER_TEXT, ansi });
    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);

    // Higher-contrast member of each pair (bright, against a dark canvas) wins.
    expect(result.tokens.link).toBe(cyanBright);
    expect(result.tokens.success).toBe(greenBright);
    expect(result.tokens.warning).toBe(yellowBright);
    expect(result.tokens.danger).toBe(redBright);

    // Independent hue proof (falsifiable against an index transposition even
    // if a future refactor stops passing the raw ANSI string straight through).
    const hueOf = (hex: string) => rgbaToOklch(parseOrThrow(hex)).h;
    expect(Math.abs(hueOf(result.tokens.link) - hueOf(cyanBright))).toBeLessThanOrEqual(1);
    expect(Math.abs(hueOf(result.tokens.success) - hueOf(greenBright))).toBeLessThanOrEqual(1);
    expect(Math.abs(hueOf(result.tokens.warning) - hueOf(yellowBright))).toBeLessThanOrEqual(1);
    expect(Math.abs(hueOf(result.tokens.danger) - hueOf(redBright))).toBeLessThanOrEqual(1);
  });

  it('derives status colors from a reference hue when no ANSI source exists', () => {
    const slots = baseSlots({
      tokens: { accent: STABLE_ACCENT },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);

    const dangerOklch = rgbaToOklch(parseOrThrow(result.tokens.danger));
    expect(Math.abs(dangerOklch.h - 25)).toBeLessThanOrEqual(1);
    expect(result.derivedTokens).toContain('danger');
  });

  it('repairs a derived accent below the 3:1 floor while preserving hue', () => {
    const slots = baseSlots({
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
      ansi: ansiWithBlue('#2b3550', undefined),
    });

    const preRepairRatio = contrastRatio('#2b3550', LADDER_CANVAS);
    expect(preRepairRatio).not.toBeNull();
    expect(preRepairRatio ?? 0).toBeLessThan(3);

    const result = deriveGaps(slots);
    if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);

    const originalHue = rgbaToOklch(parseOrThrow('#2b3550')).h;
    const repairedHue = rgbaToOklch(parseOrThrow(result.tokens.accent)).h;
    const repairedRatio = contrastRatio(result.tokens.accent, LADDER_CANVAS);

    expect(repairedRatio).not.toBeNull();
    expect(repairedRatio ?? 0).toBeGreaterThanOrEqual(3);
    expect(Math.abs(repairedHue - originalHue)).toBeLessThanOrEqual(1);
    expect(result.tokens.accent).toBe('#667290');

    // Controller ruling: focus must mirror the FINAL (post-repair) accent,
    // never the pre-repair value — rule 7's focus gap-fill runs after rule
    // 8's floor pass specifically so this holds.
    expect(result.tokens.focus).toBe(result.tokens.accent);
    expect(result.tokens.focus).toBe('#667290');
  });

  it('returns a derive error naming missing canvas and text primaries', () => {
    const result = deriveGaps(baseSlots());
    expect(result).toEqual({
      stage: 'derive',
      message: 'missing canvas/text primaries: canvas, text',
    });
  });

  it('returns a derive error when no accent source is available', () => {
    const slots = baseSlots({ background: LADDER_CANVAS, foreground: LADDER_TEXT });
    const result = deriveGaps(slots);
    expect(result).toEqual({
      stage: 'derive',
      message: 'no accent source (provide focusColor/button/ANSI blue)',
    });
  });

  it('returns a derive error for an unparseable accent source token', () => {
    const slots = baseSlots({
      tokens: { accent: 'not-a-color' },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });
    const result = deriveGaps(slots);
    expect(result).toEqual({
      stage: 'derive',
      message: 'invalid accent color: not-a-color',
    });
  });

  it('is deterministic: identical slots produce deep-equal output', () => {
    const slots = baseSlots({
      tokens: { accent: STABLE_ACCENT },
      background: LADDER_CANVAS,
      foreground: LADDER_TEXT,
    });

    const first = deriveGaps(slots);
    const second = deriveGaps(structuredClone(slots));
    expect(second).toEqual(first);
  });
});
