// Final import gate: every token must be a real, opaque color, and the two
// pairs the engine leans on for legibility (text/canvas, textMuted/canvas)
// must clear their WCAG floors. Id assembly is the store's job, not this
// one's — a caller-shaped candidate goes in, an id-less theme (or an error
// naming the offending token/pair and ratio) comes out.

import { contrastRatio } from '../../color/contrast';
import { isOpaque, parseCssColor } from '../../color/parseColor';
import { THEME_TOKEN_NAMES, type PaletteTheme, type ThemeTokens } from '../themeTypes';
import type { ImportError } from './importTypes';

const MINIMUM_TEXT_CONTRAST = 4.5;
const MINIMUM_MUTED_CONTRAST = 3;

function validateError(message: string): ImportError {
  return { stage: 'validate', message };
}

function validateTokenColors(tokens: ThemeTokens): ImportError | undefined {
  for (const name of THEME_TOKEN_NAMES) {
    const value = tokens[name];
    const rgba = parseCssColor(value);
    if (!rgba) return validateError(`invalid color for token ${name}: ${value}`);
    if (!isOpaque(rgba)) return validateError(`translucent color for token ${name}: ${value}`);
  }
  return undefined;
}

function formatRatio(ratio: number | null): string {
  return ratio === null ? 'unmeasurable' : ratio.toFixed(2);
}

function checkMinimumContrast(
  label: string,
  foreground: string,
  background: string,
  minimum: number,
): ImportError | undefined {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null || ratio < minimum) {
    return validateError(`${label} contrast ${formatRatio(ratio)}:1 below ${minimum.toString()}:1`);
  }
  return undefined;
}

export function validateImport(candidate: {
  name: string;
  mode: 'dark' | 'light';
  tokens: ThemeTokens;
}): Omit<PaletteTheme, 'id'> | ImportError {
  const tokenError = validateTokenColors(candidate.tokens);
  if (tokenError) return tokenError;

  const textError = checkMinimumContrast(
    'text/canvas',
    candidate.tokens.text,
    candidate.tokens.canvas,
    MINIMUM_TEXT_CONTRAST,
  );
  if (textError) return textError;

  const mutedError = checkMinimumContrast(
    'textMuted/canvas',
    candidate.tokens.textMuted,
    candidate.tokens.canvas,
    MINIMUM_MUTED_CONTRAST,
  );
  if (mutedError) return mutedError;

  return { name: candidate.name, mode: candidate.mode, tokens: candidate.tokens };
}
