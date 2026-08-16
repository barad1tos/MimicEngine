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
