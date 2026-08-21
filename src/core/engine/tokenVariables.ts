import { THEME_TOKEN_NAMES, type PaletteTheme, type ThemeTokenName } from '../themes';
import {
  ELEVATION_LEVELS,
  elevationBackgroundHex,
  elevationShadowValue,
  elevationVariable,
  shadowVariable,
} from './elevationScale';

const MIN_SHADOW_LEVEL = 1;

export function tokenToCssVariableSuffix(token: ThemeTokenName): string {
  return token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function elevationRampCss(theme: PaletteTheme): string {
  const lines: string[] = [];
  for (let level = 0; level < ELEVATION_LEVELS; level += 1) {
    lines.push(`  ${elevationVariable(level)}: ${elevationBackgroundHex(theme, level)};`);
  }
  for (let level = MIN_SHADOW_LEVEL; level < ELEVATION_LEVELS; level += 1) {
    lines.push(`  ${shadowVariable(level)}: ${elevationShadowValue(theme, level)};`);
  }
  return lines.join('\n');
}

export function tokenVariablesCss(theme: PaletteTheme): string {
  const declarations = THEME_TOKEN_NAMES.map(
    (tokenName) => `  --pm-${tokenToCssVariableSuffix(tokenName)}: ${theme.tokens[tokenName]};`,
  ).join('\n');

  return `:root {\n${declarations}\n${elevationRampCss(theme)}\n  color-scheme: ${theme.mode};\n}`;
}
