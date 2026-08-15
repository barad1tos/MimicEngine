import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_ID, builtInThemes, getThemeById } from './index';
import { THEME_TOKEN_NAMES } from './themeTypes';

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

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

  it('resolve the default theme and fall back to it for unknown ids', () => {
    expect(getThemeById(DEFAULT_THEME_ID).id).toBe(DEFAULT_THEME_ID);
    expect(getThemeById('does-not-exist').id).toBe(DEFAULT_THEME_ID);
  });
});
