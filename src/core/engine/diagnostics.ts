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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setDiagnostics(diagnostics: PlanDiagnostics): Promise<void> {
  const key = planStorageKey(diagnostics.siteKey);
  await browser.storage.session.set<Record<string, PlanDiagnostics>>({ [key]: diagnostics });
}

// Diagnostics are a debugging aid, never load-bearing for theming — a failed
// write here must never surface as a theming failure, hence the swallow-and-warn.
// The first write can race the background service worker's cold-start call to
// `storage.session.setAccessLevel(...)`; one bounded retry after a short delay
// covers that startup window without turning this into an unbounded retry loop.
export async function writePlanDiagnostics(diagnostics: PlanDiagnostics): Promise<void> {
  try {
    await setDiagnostics(diagnostics);
  } catch {
    try {
      await delay(1000);
      await setDiagnostics(diagnostics);
    } catch (error) {
      console.warn('[Palette Mimicry] failed to write plan diagnostics', error);
    }
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
