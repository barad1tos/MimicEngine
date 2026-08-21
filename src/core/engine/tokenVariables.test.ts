// src/core/engine/tokenVariables.test.ts
import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../themes';
import {
  elevationBackgroundHex,
  elevationShadowValue,
  elevationVariable,
  shadowVariable,
} from './elevationScale';
import { tokenVariablesCss } from './tokenVariables';

describe('tokenVariablesCss', () => {
  it('emits every --pm- token and color-scheme', () => {
    const theme = builtInThemes[0];

    const css = tokenVariablesCss(theme);

    expect(css).toContain(`--pm-canvas: ${theme.tokens.canvas}`);
    expect(css).toContain(`--pm-text-muted: ${theme.tokens.textMuted}`);
    expect(css).toContain(`color-scheme: ${theme.mode}`);
  });

  it('emits the elevation and shadow ramps, in ascending level order, after the 14 token lines', () => {
    const theme = builtInThemes[0];

    const css = tokenVariablesCss(theme);

    const elevationLines = [0, 1, 2, 3].map(
      (level) => `${elevationVariable(level)}: ${elevationBackgroundHex(theme, level)};`,
    );
    const shadowLines = [1, 2, 3].map(
      (level) => `${shadowVariable(level)}: ${elevationShadowValue(theme, level)};`,
    );

    const lastTokenLineIndex = css.indexOf(`--pm-focus: ${theme.tokens.focus};`);
    expect(lastTokenLineIndex).toBeGreaterThan(-1);

    let previousIndex = lastTokenLineIndex;
    for (const line of [...elevationLines, ...shadowLines]) {
      const index = css.indexOf(line);
      expect(index, `expected preamble to contain "${line}"`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
