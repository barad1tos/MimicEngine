import { buildOverrideRule } from '../injector/buildBaseStylesheet';
import type { SiteSettings } from '../storage/settingsStore';
import type { PaletteTheme } from '../themes';
import type { CoverageReport } from './coverage';
import { planStrategies, type StrategyPlan } from './decisionTable';
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

// Override-wins cascade contract: strategy blocks (authoredRemap,
// computedFallback, via emitGroupedRules' :where(...) wrapping — see its doc
// comment) always carry zero site-selector specificity beyond the gate.
// SiteOverride rules (buildOverrideRule, from siteSettings.overrides) are
// emitted last, verbatim and unwrapped, at their own full specificity. The
// combination means a SiteOverride always wins over a strategy-emitted rule
// for the same element: either its own selector adds specificity the
// zero-specificity strategy rule can't match, or — if somehow tied — source
// order (override always last) decides it. This is the only ordering
// guarantee the emitted blocks make; strategies themselves are unordered
// relative to each other (they never target the same declaration twice, by
// construction of the decision table).
export function composeStylesheet(
  theme: PaletteTheme,
  siteSettings: SiteSettings,
  facts: PageFacts,
  plan: StrategyPlan,
): { css: string; coverages: CoverageReport[] } {
  const selectedStrategies = planStrategies(plan);
  const outputs = strategyRegistry
    .filter((engine) => selectedStrategies.includes(engine.id))
    .map((engine) => engine.produce(theme, siteSettings, facts, plan));

  const overrideBlocks = [...siteSettings.overrides]
    .sort(compareOverrides)
    .map((override) => buildOverrideRule(override));

  const css = [tokenVariablesCss(theme), ...outputs.map((output) => output.css), ...overrideBlocks]
    .filter((block) => block.length > 0)
    .join('\n\n')
    .trim();

  const coverages = outputs.flatMap((output) => (output.coverage ? [output.coverage] : []));

  return { css, coverages };
}
