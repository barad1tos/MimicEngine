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

// Exact blocks (not loose substrings): the interactive selector
// `:where(button, [role="button"], input, select, textarea)` is shared by
// TWO separate rules post-split (Codex P2, PR #15) — an omittable
// background-only rule and an unconditional color/border/caret rule — so
// asserting on the bare selector string can't tell which rule(s) actually
// fired. Asserting on full rule blocks (selector + its own declarations)
// pins the right thing regardless of how many rules share that selector.
const interactiveBackgroundBlock =
  'html[data-pm-active="true"] :where(button, [role="button"], input, select, textarea) {\n' +
  '  background-color: var(--pm-surface1) !important;\n' +
  '}';
const interactiveHoverBackgroundBlock =
  'html[data-pm-active="true"] :where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover) {\n' +
  '  background-color: var(--pm-surface2) !important;\n' +
  '}';
const interactiveUnconditionalBlock =
  'html[data-pm-active="true"] :where(button, [role="button"], input, select, textarea) {\n' +
  '  color: var(--pm-text) !important;\n' +
  '  border-color: var(--pm-border) !important;\n' +
  '  caret-color: var(--pm-accent) !important;\n' +
  '}';

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

  it('keeps the interactive-surface background floor when the plan has no computedFallback', () => {
    const theme = builtInThemes[0];

    const { css } = baseline.produce(
      theme,
      anySiteSettings(),
      emptyFacts(),
      planWithoutComputedFallback(),
    );

    expect(css).toContain(interactiveBackgroundBlock);
    expect(css).toContain(interactiveHoverBackgroundBlock);
    expect(css).toContain(interactiveUnconditionalBlock);
  });

  it('omits the interactive-surface background floor when the plan includes computedFallback, keeping caret-color and ground rules', () => {
    // Amendment 2 regression: baseline's generic button/input opaque-
    // BACKGROUND floor bled onto transparent, more-classed controls
    // (LinkedIn top-bar nav buttons) when the census could already see and
    // paint the page's real surfaces. Only the background declarations
    // (base + :hover) yield — never color/border-color/caret-color: a
    // computedFallback-bearing plan must still theme an input's caret,
    // since the census never samples caret-color at all (Codex P2, PR #15)
    // and nothing else could ever restore it.
    const theme = builtInThemes[0];

    const { css } = baseline.produce(
      theme,
      anySiteSettings(),
      emptyFacts(),
      planWithComputedFallback(),
    );

    expect(css).not.toContain(interactiveBackgroundBlock);
    expect(css).not.toContain(interactiveHoverBackgroundBlock);
    expect(css).toContain(interactiveUnconditionalBlock);
    expect(css).toContain('var(--pm-canvas)');
    expect(css).toContain('color: inherit;');
  });
});
