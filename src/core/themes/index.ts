import { ayuMirage } from './built-in/ayu';
import { catppuccinFrappe } from './built-in/catppuccin';
import { everforestDark } from './built-in/everforest';
import type { PaletteTheme } from './themeTypes';

export const builtInThemes = [
  catppuccinFrappe,
  ayuMirage,
  everforestDark,
] as const satisfies readonly PaletteTheme[];

export type BuiltInThemeId = (typeof builtInThemes)[number]['id'];

export const DEFAULT_THEME_ID: BuiltInThemeId = 'catppuccin-frappe';

// Resolves a theme id against built-in themes first, then imported themes,
// falling back to the default (catppuccin-frappe) when neither has a match.
// Built-ins take precedence on an id collision -- unreachable in practice
// since imported ids are always namespaced `imported:<slug>` (see
// importedThemeId in importedThemesStore.ts), but the precedence order is
// still asserted structurally by resolveTheme's tests.
export function resolveTheme(
  themeId: string,
  importedThemes: readonly PaletteTheme[],
): PaletteTheme {
  const builtIn = builtInThemes.find((theme) => theme.id === themeId);
  if (builtIn) return builtIn;

  return importedThemes.find((theme) => theme.id === themeId) ?? catppuccinFrappe;
}

export { THEME_TOKEN_NAMES } from './themeTypes';
export type { PaletteTheme, ThemeTokenName, ThemeTokens } from './themeTypes';
