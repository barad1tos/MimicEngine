// src/core/engine/composeStylesheet.test.ts
import { describe, expect, it } from 'vitest';
import { builtInThemes } from '../themes';
import type { SiteSettings } from '../storage/settingsStore';
import { createDefaultSiteSettings } from '../storage/settingsStore';
import { composeStylesheet } from './composeStylesheet';
import type { StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';

const theme = builtInThemes[0];

const facts: PageFacts = {
  customProperties: [],
  authoredRules: [],
  inlineStyleColors: [],
  svgPresentationColors: [],
  domElementCount: 100,
  shadowRootCount: 0,
  stylesheetCount: 0,
  unreadableStylesheetCount: 0,
};

const emptyPlan: StrategyPlan = {
  provenance: { kind: 'auto', rule: 'default', strategies: [], reasons: [], tableVersion: 1 },
};

const fullPlan: StrategyPlan = {
  provenance: {
    kind: 'auto',
    rule: 'variables-capable',
    strategies: ['baseline', 'variableRemap'],
    reasons: [],
    tableVersion: 1,
  },
};

function siteSettingsWithOverrides(): SiteSettings {
  return {
    ...createDefaultSiteSettings(theme.id),
    overrides: [
      { selector: '.zebra', property: 'color', token: 'text' },
      { selector: '.alpha', property: 'border-color', token: 'border' },
      { selector: '.alpha', property: 'background-color', token: 'surface1' },
    ],
  };
}

describe('composeStylesheet', () => {
  it('is deterministic across identical calls', () => {
    const siteSettings = siteSettingsWithOverrides();

    const first = composeStylesheet(theme, siteSettings, facts, fullPlan);
    const second = composeStylesheet(theme, siteSettings, facts, fullPlan);

    expect(first.css).toBe(second.css);
  });

  it('produces the same bytes regardless of plan strategy order', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);
    const forwardOrder: StrategyPlan = {
      provenance: {
        kind: 'auto',
        rule: 'variables-capable',
        strategies: ['baseline', 'variableRemap'],
        reasons: [],
        tableVersion: 1,
      },
    };
    const reverseOrder: StrategyPlan = {
      provenance: {
        kind: 'auto',
        rule: 'variables-capable',
        strategies: ['variableRemap', 'baseline'],
        reasons: [],
        tableVersion: 1,
      },
    };

    const forward = composeStylesheet(theme, siteSettings, facts, forwardOrder);
    const reverse = composeStylesheet(theme, siteSettings, facts, reverseOrder);

    expect(forward.css).toBe(reverse.css);
  });

  it('emits override rules last, sorted by selector then property', () => {
    const siteSettings = siteSettingsWithOverrides();

    const { css } = composeStylesheet(theme, siteSettings, facts, fullPlan);

    // Unique to buildBaseStylesheet's output — proves overrides trail strategy CSS,
    // not just the preamble.
    const baselineMarker = css.indexOf('::selection');
    const alphaBackground = css.indexOf('.alpha { background-color:');
    const alphaBorder = css.indexOf('.alpha { border-color:');
    const zebraColor = css.indexOf('.zebra { color:');

    expect(baselineMarker).toBeGreaterThanOrEqual(0);
    expect(alphaBackground).toBeGreaterThan(baselineMarker);
    expect(alphaBorder).toBeGreaterThan(alphaBackground);
    expect(zebraColor).toBeGreaterThan(alphaBorder);
  });

  it('always emits the token-variables preamble, even for an empty plan', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);

    const { css } = composeStylesheet(theme, siteSettings, facts, emptyPlan);

    expect(css).toContain(':root {');
    expect(css).toContain(`--pm-canvas: ${theme.tokens.canvas}`);
  });

  it('override-wins cascade contract: a SiteOverride beats a higher-raw-specificity strategy rule', () => {
    // The strategy (authoredRemap) rule targets a deliberately high-specificity
    // selector; the override targets a plain, low-specificity one that still
    // matches the same element. Per StylePlan's :where(...) wrapping,
    // the strategy rule's selector contributes zero specificity beyond the
    // gate, so the override's own selector — however plain — always wins,
    // and composeStylesheet emits overrides last as a source-order backstop
    // for any tie.
    const authoredRemapPlan: StrategyPlan = {
      provenance: {
        kind: 'auto',
        rule: 'test',
        strategies: ['authoredRemap'],
        reasons: [],
        tableVersion: 1,
      },
    };
    const factsWithHighSpecificityRule: PageFacts = {
      ...facts,
      authoredRules: [
        {
          selector: '#app .card.featured.special',
          property: 'color',
          value: '#c9c9d1',
          color: { r: 0xc9, g: 0xc9, b: 0xd1, a: 1 },
          bucket: 'text',
          conditions: [],
        },
      ],
    };
    const siteSettings: SiteSettings = {
      ...createDefaultSiteSettings(theme.id),
      overrides: [{ selector: '.card', property: 'color', token: 'success' }],
    };

    const { css } = composeStylesheet(
      theme,
      siteSettings,
      factsWithHighSpecificityRule,
      authoredRemapPlan,
    );

    // The strategy rule's site selector is neutralized inside :where(...).
    expect(css).toContain(':where(#app .card.featured.special)');
    // The override rule is unwrapped, at full specificity.
    const overrideRule = '.card { color: var(--pm-success) !important; }';
    expect(css).toContain(overrideRule);
    // Source order: the override trails the strategy block, the tiebreak
    // backstop if specificity were ever equal.
    expect(css.indexOf(overrideRule)).toBeGreaterThan(
      css.indexOf(':where(#app .card.featured.special)'),
    );
  });

  it('collects coverage reports only from selected strategies that produce them', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);
    const authoredRemapPlan: StrategyPlan = {
      provenance: {
        kind: 'auto',
        rule: 'test',
        strategies: ['baseline', 'authoredRemap'],
        reasons: [],
        tableVersion: 1,
      },
    };

    const { coverages } = composeStylesheet(theme, siteSettings, facts, authoredRemapPlan);

    expect(coverages).toEqual([{ discovered: 0, mapped: 0, ratio: 0 }]);
  });

  it('returns an empty coverages array when no selected strategy reports coverage', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);

    const { coverages } = composeStylesheet(theme, siteSettings, facts, fullPlan);

    expect(coverages).toEqual([]);
  });

  it('a composed manual deepRemap plan emits baseline, then the composed auto strategies, then deepRemap last — registry order, not plan-array order', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);
    const composedDeepRemapPlan: StrategyPlan = {
      provenance: {
        kind: 'manual',
        strategy: 'deepRemap',
        composed: {
          rule: 'variables-capable',
          strategies: ['baseline', 'variableRemap'],
          tableVersion: 1,
        },
      },
    };
    const factsWithVariableAndSvg: PageFacts = {
      ...facts,
      customProperties: [
        {
          name: '--page-bg',
          value: '#1f2430',
          color: { r: 0x1f, g: 0x24, b: 0x30, a: 1 },
          usage: { background: 1, text: 0, border: 0, other: 0 },
        },
      ],
      svgPresentationColors: [
        { attribute: 'fill', value: '#101014', color: { r: 0x10, g: 0x10, b: 0x14, a: 1 } },
      ],
    };

    const { css } = composeStylesheet(
      theme,
      siteSettings,
      factsWithVariableAndSvg,
      composedDeepRemapPlan,
    );

    const baselineMarker = css.indexOf('::selection');
    const variableRemapMarker = css.indexOf('--page-bg: var(--pm-elevation-0)');
    const deepRemapMarker = css.indexOf(':is(svg, svg *)[fill=');

    expect(baselineMarker).toBeGreaterThanOrEqual(0);
    expect(variableRemapMarker).toBeGreaterThan(baselineMarker);
    expect(deepRemapMarker).toBeGreaterThan(variableRemapMarker);
  });
});
