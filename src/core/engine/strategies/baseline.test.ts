import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../../themes';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import type { PageFacts } from '../pageFacts';
import type { SiteSettings } from '../../storage/settingsStore';
import { baseline } from './baseline';

function anySiteSettings(): SiteSettings {
  return {
    enabled: true,
    themeId: 'placeholder-theme',
    strategy: 'auto',
    preserveImages: true,
    preserveBrandColors: true,
    overrides: [],
  };
}

function anyPlan(): StrategyPlan {
  return {
    provenance: {
      kind: 'auto',
      rule: 'test',
      strategies: ['baseline', 'variableRemap', 'authoredRemap', 'computedFallback'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    },
  };
}

function emptyFacts(): PageFacts {
  return {
    customProperties: [],
    authoredRules: [],
    inlineStyleColors: [],
    svgPresentationColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    stylesheetCount: 0,
    unreadableStylesheetCount: 0,
  };
}

describe('baseline strategy', () => {
  it('emits gated generic rules without the :root preamble', () => {
    const theme = builtInThemes[0];

    const { css } = baseline.produce(theme, anySiteSettings(), emptyFacts(), anyPlan());

    expect(css).toContain('html[data-pm-active="true"]');
    expect(css).not.toContain(':root {');
    expect(css).toContain('var(--pm-canvas)');
  });
});
