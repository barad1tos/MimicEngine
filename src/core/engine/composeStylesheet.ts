import { buildOverrideRule } from '../injector/buildBaseStylesheet';
import type { SiteSettings } from '../storage/settingsStore';
import type { PaletteTheme } from '../themes';
import type { StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';
import { strategyRegistry } from './registry';
import { compareStrings } from './sort';
import { tokenVariablesCss } from './tokenVariables';

function compareOverrides(
  a: SiteSettings['overrides'][number],
  b: SiteSettings['overrides'][number],
): number {
  return compareStrings(a.selector, b.selector) || compareStrings(a.property, b.property);
}

export function composeStylesheet(
  theme: PaletteTheme,
  siteSettings: SiteSettings,
  facts: PageFacts,
  plan: StrategyPlan,
): string {
  const strategyBlocks = strategyRegistry
    .filter((engine) => plan.strategies.includes(engine.id))
    .map((engine) => engine.produceCss(theme, siteSettings, facts));

  const overrideBlocks = [...siteSettings.overrides]
    .sort(compareOverrides)
    .map((override) => buildOverrideRule(override));

  return [tokenVariablesCss(theme), ...strategyBlocks, ...overrideBlocks]
    .filter((block) => block.length > 0)
    .join('\n\n')
    .trim();
}
