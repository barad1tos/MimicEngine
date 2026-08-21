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

function planWithoutComputedFallback(): StrategyPlan {
  return {
    provenance: {
      kind: 'auto',
      rule: 'test',
      strategies: ['baseline', 'variableRemap', 'authoredRemap'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    },
  };
}

function planWithComputedFallback(): StrategyPlan {
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

    const { css } = baseline.produce(
      theme,
      anySiteSettings(),
      emptyFacts(),
      planWithoutComputedFallback(),
    );

    expect(css).toContain('html[data-pm-active="true"]');
    expect(css).not.toContain(':root {');
    expect(css).toContain('var(--pm-canvas)');
  });

  it('keeps the interactive-surface floor when the plan has no computedFallback', () => {
    const theme = builtInThemes[0];

    const { css } = baseline.produce(
      theme,
      anySiteSettings(),
      emptyFacts(),
      planWithoutComputedFallback(),
    );

    expect(css).toContain(':where(button, [role="button"], input, select, textarea)');
    expect(css).toContain('background-color: var(--pm-surface1) !important;');
    expect(css).toContain(
      ':where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover)',
    );
  });

  it('omits the interactive-surface floor when the plan includes computedFallback, keeping ground/text rules', () => {
    // Amendment 2 regression: baseline's generic button/input opaque-
    // background floor bled onto transparent, more-classed controls
    // (LinkedIn top-bar nav buttons) when the census could already see and
    // paint the page's real surfaces. The floor must yield entirely — base
    // AND :hover variants — while non-interactive rules (canvas/text ground,
    // inherited text color) stay untouched.
    const theme = builtInThemes[0];

    const { css } = baseline.produce(
      theme,
      anySiteSettings(),
      emptyFacts(),
      planWithComputedFallback(),
    );

    expect(css).not.toContain(':where(button, [role="button"], input, select, textarea)');
    expect(css).not.toContain(
      ':where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover)',
    );
    expect(css).toContain('var(--pm-canvas)');
    expect(css).toContain('color: inherit;');
  });
});
