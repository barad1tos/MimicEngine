import type { PaletteTheme, ThemeTokenName, ThemeTokens } from '../themeTypes';

export type SourceFormatId =
  'jetbrains-ui' | 'jetbrains-editor' | 'vscode' | 'iterm' | 'alacritty' | 'kitty' | 'ghostty';

export type ThemeSlots = {
  name: string;
  sourceFormat: SourceFormatId;
  mode?: 'dark' | 'light'; // explicit source metadata (JetBrains `dark`, VS Code `type`)
  tokens: Partial<ThemeTokens>; // opaque hex only (adapters composite alpha)
  ansi?: readonly (string | undefined)[]; // up to 16, sparse
  background?: string;
  foreground?: string;
  author?: string; // source-declared author metadata; only jetbrains-ui carries one
};

export type ImportError = {
  stage: 'detect' | 'parse' | 'derive' | 'validate';
  message: string;
};

export type ImportResult =
  | {
      ok: true;
      theme: PaletteTheme;
      sourceFormat: SourceFormatId;
      derivedTokens: readonly ThemeTokenName[];
    }
  | { ok: false; error: ImportError };

// Format-default names each nameless-capable adapter falls back to when its
// source carries no name of its own. Single source of truth: adapters
// import their own constant instead of duplicating the literal, and the
// options page's queue-resolve step checks the full set to detect a
// nameless import and prefill a stronger name from the picked file instead
// of letting two unnamed imports collide on the same slug.
export const VSCODE_THEME_NAME = 'VS Code theme';
export const ITERM_THEME_NAME = 'iTerm theme';
export const ALACRITTY_THEME_NAME = 'Alacritty theme';
export const KITTY_THEME_NAME = 'kitty theme';
export const GHOSTTY_THEME_NAME = 'Ghostty theme';

export const FORMAT_DEFAULT_THEME_NAMES: ReadonlySet<string> = new Set([
  VSCODE_THEME_NAME,
  ITERM_THEME_NAME,
  ALACRITTY_THEME_NAME,
  KITTY_THEME_NAME,
  GHOSTTY_THEME_NAME,
]);
