import type { PaletteTheme } from '../themes';
import type { SiteSettings } from '../storage/settingsStore';
import type { PageFacts } from './pageFacts';
import type { StrategyId } from './strategyId';
import { baseline } from './strategies/baseline';

export type PaletteEngine = {
  id: StrategyId;
  label: string;
  produceCss(theme: PaletteTheme, siteSettings: SiteSettings, facts: PageFacts): string;
};

export const strategyRegistry: readonly PaletteEngine[] = [baseline];
