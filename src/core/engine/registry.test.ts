// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { SiteSettings } from '../storage/settingsStore';
import { builtInThemes } from '../themes';
import { TABLE_VERSION, type StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';
import { strategyRegistry } from './registry';
import { STRATEGY_IDS } from './strategyId';

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
      strategies: [...STRATEGY_IDS],
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

describe('strategyRegistry', () => {
  it('registers exactly the ids declared in STRATEGY_IDS, drift-free', () => {
    expect(strategyRegistry.map((engine) => engine.id)).toEqual([...STRATEGY_IDS]);
  });

  it('every registry entry exposes produce returning { css: string }', () => {
    const theme = builtInThemes[0];

    for (const engine of strategyRegistry) {
      const output = engine.produce(theme, anySiteSettings(), emptyFacts(), anyPlan());
      expect(typeof output.css).toBe('string');
    }
  });
});
