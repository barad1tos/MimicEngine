export const THEME_TOKEN_NAMES = [
  'canvas',
  'surface1',
  'surface2',
  'surface3',
  'text',
  'textMuted',
  'border',
  'accent',
  'link',
  'success',
  'warning',
  'danger',
  'selection',
  'focus',
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

export type ThemeTokens = Record<ThemeTokenName, string>;

export type PaletteTheme = {
  id: string;
  name: string;
  author?: string;
  mode: 'dark' | 'light';
  tokens: ThemeTokens;
};
