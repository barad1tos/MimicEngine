import { describe, expect, it } from 'vitest';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  ELEVATION_LEVELS,
  elevationBackgroundHex,
  elevationShadowValue,
  elevationVariable,
  shadowVariable,
} from './elevationScale';

const darkTheme = builtInThemes[0];
const ayuMirageTheme = builtInThemes.find((theme) => theme.id === 'ayu-mirage');
if (!ayuMirageTheme) throw new Error('ayu-mirage missing from builtInThemes fixture');

describe('elevationBackgroundHex', () => {
  it('uses the theme semantic surface ladder for raised levels', () => {
    expect(
      Array.from({ length: ELEVATION_LEVELS }, (_, level) =>
        elevationBackgroundHex(ayuMirageTheme, level),
      ),
    ).toEqual([
      ayuMirageTheme.tokens.canvas,
      ayuMirageTheme.tokens.surface1,
      ayuMirageTheme.tokens.surface2,
      ayuMirageTheme.tokens.surface3,
    ]);
  });

  it.each(builtInThemes)('preserves every authored surface color for $id', (theme) => {
    const expected = [
      theme.tokens.canvas,
      theme.tokens.surface1,
      theme.tokens.surface2,
      theme.tokens.surface3,
    ];

    expect(expected.map((_, level) => elevationBackgroundHex(theme, level))).toEqual(expected);
  });

  it('clamps levels into the semantic surface range', () => {
    expect(elevationBackgroundHex(darkTheme, -5)).toBe(darkTheme.tokens.canvas);
    expect(elevationBackgroundHex(darkTheme, 9)).toBe(darkTheme.tokens.surface3);
  });

  it('reports the invalid semantic token', () => {
    const invalidTheme: PaletteTheme = {
      ...darkTheme,
      tokens: { ...darkTheme.tokens, surface2: 'not-a-color' },
    };

    expect(() => elevationBackgroundHex(invalidTheme, 2)).toThrow(
      'invalid surface2 token color: not-a-color',
    );
  });
});

describe('elevationShadowValue', () => {
  it.each([1, 2, 3])('scales offset-y and blur with level %i and is deterministic', (level) => {
    const value = elevationShadowValue(darkTheme, level);

    expect(value).toBe(elevationShadowValue(darkTheme, level));
    expect(value).toMatch(
      new RegExp(
        `^0 ${(2 * level).toString()}px ${(6 * level).toString()}px rgba\\(\\d+, \\d+, \\d+, 0\\.5\\)$`,
      ),
    );
  });

  it('clamps shadow levels to 1 through 3', () => {
    expect(elevationShadowValue(darkTheme, 0)).toBe(elevationShadowValue(darkTheme, 1));
    expect(elevationShadowValue(darkTheme, 4)).toBe(elevationShadowValue(darkTheme, 3));
  });

  it('keeps the canvas-derived shadow color stable across levels', () => {
    const level1Color = /rgba\([^)]+\)/.exec(elevationShadowValue(darkTheme, 1))?.[0];
    const level3Color = /rgba\([^)]+\)/.exec(elevationShadowValue(darkTheme, 3))?.[0];
    expect(level1Color).toBe(level3Color);
  });
});

describe('variable name helpers', () => {
  it.each([
    [0, '--pm-elevation-0'],
    [1, '--pm-elevation-1'],
    [2, '--pm-elevation-2'],
    [3, '--pm-elevation-3'],
  ] as const)('elevationVariable(%i) -> %s', (level, expected) => {
    expect(elevationVariable(level)).toBe(expected);
  });

  it.each([
    [1, '--pm-shadow-1'],
    [2, '--pm-shadow-2'],
    [3, '--pm-shadow-3'],
  ] as const)('shadowVariable(%i) -> %s', (level, expected) => {
    expect(shadowVariable(level)).toBe(expected);
  });
});
