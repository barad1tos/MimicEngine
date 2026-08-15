import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../../themes';
import type { PageFacts } from '../pageFacts';
import type { SiteSettings } from '../../storage/settingsStore';
import { baseline } from './baseline';

function anySiteSettings(): SiteSettings {
  return {
    enabled: true,
    themeId: 'placeholder-theme',
    strategy: 'auto',
    preserveImages: true,
    overrides: [],
  };
}

function emptyFacts(): PageFacts {
  return {
    customProperties: [],
    domElementCount: 0,
    shadowRootCount: 0,
    styleSheetCount: 0,
    unreadableStyleSheetCount: 0,
  };
}

describe('baseline strategy', () => {
  it('emits gated generic rules without the :root preamble', () => {
    const theme = builtInThemes[0];

    const css = baseline.produceCss(theme, anySiteSettings(), emptyFacts());

    expect(css).toContain('html[data-pm-active="true"]');
    expect(css).not.toContain(':root {');
    expect(css).toContain('var(--pm-canvas)');
  });
});
