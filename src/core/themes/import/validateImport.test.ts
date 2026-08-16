import { describe, expect, it } from 'vitest';
import type { ThemeTokens } from '../themeTypes';
import { validateImport } from './validateImport';

// Known-good baseline (Ayu Mirage's own token set) so each negative test can
// mutate exactly one token and know every other check already passes.
const VALID_TOKENS: ThemeTokens = {
  canvas: '#1f2430',
  surface1: '#242936',
  surface2: '#2b3242',
  surface3: '#343f4a',
  text: '#cbccc6',
  textMuted: '#707a8c',
  border: '#343f4a',
  accent: '#ffcc66',
  link: '#5ccfe6',
  success: '#bae67e',
  warning: '#ffd580',
  danger: '#ff6666',
  selection: '#34455a',
  focus: '#5ccfe6',
};

describe('validateImport', () => {
  it('returns the theme shape for a fully valid candidate', () => {
    const result = validateImport({ name: 'Ayu Mirage', mode: 'dark', tokens: VALID_TOKENS });
    expect(result).toEqual({ name: 'Ayu Mirage', mode: 'dark', tokens: VALID_TOKENS });
  });

  it('returns a validate error naming the ratio when text/canvas contrast is below 4.5', () => {
    const tokens: ThemeTokens = { ...VALID_TOKENS, text: '#55555d' };
    const result = validateImport({ name: 'Low contrast', mode: 'dark', tokens });
    expect(result).toEqual({
      stage: 'validate',
      message: 'text/canvas contrast 2.10:1 below 4.5:1',
    });
  });

  it('returns a validate error naming the ratio when textMuted/canvas contrast is below 3.0', () => {
    const tokens: ThemeTokens = { ...VALID_TOKENS, textMuted: '#2a2f3c' };
    const result = validateImport({ name: 'Low muted contrast', mode: 'dark', tokens });
    expect(result).toEqual({
      stage: 'validate',
      message: 'textMuted/canvas contrast 1.16:1 below 3:1',
    });
  });

  it('returns a validate error for a translucent token', () => {
    const tokens: ThemeTokens = { ...VALID_TOKENS, surface1: 'rgba(36,41,54,0.5)' };
    const result = validateImport({ name: 'Translucent', mode: 'dark', tokens });
    expect(result).toEqual({
      stage: 'validate',
      message: 'translucent color for token surface1: rgba(36,41,54,0.5)',
    });
  });

  it('returns a validate error for an unparseable token color', () => {
    const tokens: ThemeTokens = { ...VALID_TOKENS, border: 'not-a-color' };
    const result = validateImport({ name: 'Invalid', mode: 'dark', tokens });
    expect(result).toEqual({
      stage: 'validate',
      message: 'invalid color for token border: not-a-color',
    });
  });
});
