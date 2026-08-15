import type { PaletteTheme } from '../themes';
import type { SiteSettings } from '../storage/settingsStore';
import type { StrategyPlan } from './decisionTable';
import type { PageFacts } from './pageFacts';
import type { StrategyId } from './strategyId';
import { authoredRemap } from './strategies/authoredRemap';
import { baseline } from './strategies/baseline';
import { computedFallback } from './strategies/computedFallback';
import { variableRemap } from './strategies/variableRemap';

export type PaletteEngine = {
  id: StrategyId;
  label: string;
  produceCss(
    theme: PaletteTheme,
    siteSettings: SiteSettings,
    facts: PageFacts,
    plan: StrategyPlan,
  ): string;
};

export const strategyRegistry: readonly PaletteEngine[] = [
  baseline,
  variableRemap,
  authoredRemap,
  computedFallback,
];
