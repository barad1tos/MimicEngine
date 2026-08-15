import { browser } from 'wxt/browser';
import type { StrategyPlan } from './decisionTable';
import type { PageMetrics } from './pageMetrics';

export type PlanDiagnostics = {
  siteKey: string;
  plan: StrategyPlan;
  metrics: PageMetrics;
  updatedAt: string;
};

export const PLAN_STORAGE_PREFIX = 'palette-mimicry:plan:';

export function planStorageKey(siteKey: string): string {
  return `${PLAN_STORAGE_PREFIX}${siteKey}`;
}

// Diagnostics are a debugging aid, never load-bearing for theming — a failed
// write here must never surface as a theming failure, hence the swallow-and-warn.
export async function writePlanDiagnostics(diagnostics: PlanDiagnostics): Promise<void> {
  try {
    const key = planStorageKey(diagnostics.siteKey);
    await browser.storage.session.set<Record<string, PlanDiagnostics>>({ [key]: diagnostics });
  } catch (error) {
    console.warn('[Palette Mimicry] failed to write plan diagnostics', error);
  }
}

export async function readPlanDiagnostics(siteKey: string): Promise<PlanDiagnostics | null> {
  try {
    const key = planStorageKey(siteKey);
    const result = await browser.storage.session.get<Record<string, PlanDiagnostics>>(key);
    return result[key] ?? null;
  } catch (error) {
    console.warn('[Palette Mimicry] failed to read plan diagnostics', error);
    return null;
  }
}
