import { THEME_TOKEN_NAMES, type PaletteTheme, type ThemeTokenName } from '../themes';

export function tokenToCssVariableSuffix(token: ThemeTokenName): string {
  return token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function tokenVariablesCss(theme: PaletteTheme): string {
  const declarations = THEME_TOKEN_NAMES.map(
    (tokenName) => `  --pm-${tokenToCssVariableSuffix(tokenName)}: ${theme.tokens[tokenName]};`,
  ).join('\n');

  return `:root {\n${declarations}\n  color-scheme: ${theme.mode};\n}`;
}
