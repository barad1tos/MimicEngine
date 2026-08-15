// src/core/engine/tokenVariables.test.ts
import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../themes';
import { tokenVariablesCss } from './tokenVariables';

describe('tokenVariablesCss', () => {
  it('emits every --pm- token and color-scheme', () => {
    const theme = builtInThemes[0];

    const css = tokenVariablesCss(theme);

    expect(css).toContain(`--pm-canvas: ${theme.tokens.canvas}`);
    expect(css).toContain(`--pm-text-muted: ${theme.tokens.textMuted}`);
    expect(css).toContain(`color-scheme: ${theme.mode}`);
  });
});
