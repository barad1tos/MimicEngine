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
  domElementCount: 100,
  shadowRootCount: 0,
  styleSheetCount: 0,
  unreadableStyleSheetCount: 0,
};

const emptyPlan: StrategyPlan = {
  strategies: [],
  provenance: { kind: 'auto', rule: 'default', reasons: [], tableVersion: 1 },
};

const fullPlan: StrategyPlan = {
  strategies: ['baseline', 'variableRemap'],
  provenance: { kind: 'auto', rule: 'variables-capable', reasons: [], tableVersion: 1 },
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

    expect(first).toBe(second);
  });

  it('produces the same bytes regardless of plan strategy order', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);
    const forwardOrder: StrategyPlan = { ...fullPlan, strategies: ['baseline', 'variableRemap'] };
    const reverseOrder: StrategyPlan = { ...fullPlan, strategies: ['variableRemap', 'baseline'] };

    const forward = composeStylesheet(theme, siteSettings, facts, forwardOrder);
    const reverse = composeStylesheet(theme, siteSettings, facts, reverseOrder);

    expect(forward).toBe(reverse);
  });

  it('emits override rules last, sorted by selector then property', () => {
    const siteSettings = siteSettingsWithOverrides();

    const css = composeStylesheet(theme, siteSettings, facts, emptyPlan);

    const alphaBackground = css.indexOf('.alpha { background-color:');
    const alphaBorder = css.indexOf('.alpha { border-color:');
    const zebraColor = css.indexOf('.zebra { color:');

    expect(alphaBackground).toBeGreaterThanOrEqual(0);
    expect(alphaBorder).toBeGreaterThan(alphaBackground);
    expect(zebraColor).toBeGreaterThan(alphaBorder);
  });

  it('always emits the token-variables preamble, even for an empty plan', () => {
    const siteSettings = createDefaultSiteSettings(theme.id);

    const css = composeStylesheet(theme, siteSettings, facts, emptyPlan);

    expect(css).toContain(':root {');
    expect(css).toContain(`--pm-canvas: ${theme.tokens.canvas}`);
  });
});
