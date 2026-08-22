import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../themes';
import { createDefaultSiteSettings } from '../storage/settingsStore';
import { buildBootstrapStylesheet } from './buildBootstrapStylesheet';

const theme = builtInThemes.find(({ id }) => id === 'ayu-mirage') ?? builtInThemes[0];

describe('buildBootstrapStylesheet', () => {
  it('composes theme tokens, conservative base rules, and canonical overrides', () => {
    const settings = {
      ...createDefaultSiteSettings(theme.id),
      overrides: [
        { selector: '.zebra', property: 'color', token: 'text' as const },
        { selector: '.alpha', property: 'border-color', token: 'border' as const },
        { selector: '.alpha', property: 'background-color', token: 'surface1' as const },
      ],
    };

    const css = buildBootstrapStylesheet(theme, settings);

    expect(css).toContain(`--pm-canvas: ${theme.tokens.canvas}`);
    expect(css).toContain(
      'html[data-pm-active="true"] :where(button, [role="button"], input, select, textarea) {\n  color: var(--pm-text) !important;',
    );
    expect(css).not.toContain(
      'html[data-pm-active="true"] :where(button, [role="button"], input, select, textarea) {\n  background-color:',
    );

    const alphaBackground = css.indexOf('.alpha { background-color:');
    const alphaBorder = css.indexOf('.alpha { border-color:');
    const zebraColor = css.indexOf('.zebra { color:');
    expect(alphaBackground).toBeGreaterThanOrEqual(0);
    expect(alphaBorder).toBeGreaterThan(alphaBackground);
    expect(zebraColor).toBeGreaterThan(alphaBorder);
  });

  it('returns byte-identical css for identical inputs', () => {
    const settings = createDefaultSiteSettings(theme.id);

    expect(buildBootstrapStylesheet(theme, settings)).toBe(
      buildBootstrapStylesheet(theme, settings),
    );
  });
});
