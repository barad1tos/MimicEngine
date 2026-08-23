import type { SiteSettings } from '../storage/settingsStore';
import type { PaletteTheme } from '../themes';
import type { StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';
import { authoredRemap } from './strategies/authoredRemap';
import { baseline } from './strategies/baseline';
import { computedFallback } from './strategies/computedFallback';
import { deepRemap } from './strategies/deepRemap';
import { variableRemap } from './strategies/variableRemap';
import type { StrategyId } from './strategyId';
import type { StyleSection } from './stylePlan';

export type StrategyOutput = StyleSection;

export type PaletteEngine = {
  id: StrategyId;
  label: string;
  produce(
    theme: PaletteTheme,
    siteSettings: SiteSettings,
    facts: PageFacts,
    plan: StrategyPlan,
  ): StrategyOutput;
};

export const strategyRegistry: readonly PaletteEngine[] = [
  baseline,
  variableRemap,
  authoredRemap,
  computedFallback,
  deepRemap,
];
