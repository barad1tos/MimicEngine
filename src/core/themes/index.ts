import { ayuMirage } from './built-in/ayu';
import { catppuccinFrappe } from './built-in/catppuccin';
import { everforestDark } from './built-in/everforest';
import type { PaletteTheme } from './themeTypes';

export const builtInThemes = [catppuccinFrappe, ayuMirage, everforestDark] as const satisfies readonly PaletteTheme[];

export type BuiltInThemeId = (typeof builtInThemes)[number]['id'];

export const DEFAULT_THEME_ID: BuiltInThemeId = 'catppuccin-frappe';

export function getThemeById(themeId: string): PaletteTheme {
  return builtInThemes.find((theme) => theme.id === themeId) ?? catppuccinFrappe;
}

export type { PaletteTheme, ThemeTokenName, ThemeTokens } from './themeTypes';
