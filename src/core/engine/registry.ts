import type { SiteSettings } from '../storage/settingsStore';
import type { PaletteTheme } from '../themes';
import type { CoverageReport } from './coverage';
import type { StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';
import { authoredRemap } from './strategies/authoredRemap';
import { baseline } from './strategies/baseline';
import { computedFallback } from './strategies/computedFallback';
import { variableRemap } from './strategies/variableRemap';
import type { StrategyId } from './strategyId';

export type StrategyOutput = {
  css: string;
  coverage?: CoverageReport;
};

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
];
