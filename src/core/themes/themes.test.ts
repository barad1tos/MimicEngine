import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_ID, builtInThemes, resolveTheme } from './index';
import { THEME_TOKEN_NAMES } from './themeTypes';
import type { PaletteTheme } from './themeTypes';

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function buildImportedTheme(id: string): PaletteTheme {
  const tokens = Object.fromEntries(
    THEME_TOKEN_NAMES.map((tokenName) => [tokenName, '#123456']),
  ) as PaletteTheme['tokens'];

  return { id, name: 'Imported Stand-in', mode: 'dark', tokens };
}

describe('builtInThemes', () => {
  it('have unique ids', () => {
    const ids = builtInThemes.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('define every theme token as a valid hex color', () => {
    for (const theme of builtInThemes) {
      for (const token of THEME_TOKEN_NAMES) {
        expect(theme.tokens[token], `${theme.id}: ${token}`).toMatch(HEX_COLOR);
      }
    }
  });
});

describe('resolveTheme', () => {
  it('resolves a built-in id without consulting imported themes', () => {
    expect(resolveTheme(DEFAULT_THEME_ID, []).id).toBe(DEFAULT_THEME_ID);
  });

  it('finds an imported theme by id when no built-in matches', () => {
    const imported = buildImportedTheme('imported:my-theme');

    expect(resolveTheme('imported:my-theme', [imported])).toBe(imported);
  });

  it('lets a built-in id shadow an imported theme registered under the same id', () => {
    const shadowing = buildImportedTheme(DEFAULT_THEME_ID);

    expect(resolveTheme(DEFAULT_THEME_ID, [shadowing]).id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme(DEFAULT_THEME_ID, [shadowing])).not.toBe(shadowing);
  });

  it('falls back to the default theme for an unknown id', () => {
    expect(resolveTheme('does-not-exist', []).id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme('does-not-exist', [buildImportedTheme('imported:other')]).id).toBe(
      DEFAULT_THEME_ID,
    );
  });
});
