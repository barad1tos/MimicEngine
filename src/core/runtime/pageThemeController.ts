import { composeStylesheet } from '../engine/composeStylesheet';
import { decideStrategies, type StrategyPlan } from '../engine/decisionTable';
import { writePlanDiagnostics } from '../engine/diagnostics';
import { collectPageFacts } from '../engine/pageFacts';
import { deriveMetrics } from '../engine/pageMetrics';
import { injectStylesheet, removeStylesheet } from '../injector/styleElement';
import { observeDomChanges, type DomChangeObserver } from '../live/observeDomChanges';
import {
  getEffectiveSiteSettings,
  onSettingsChanged,
  type SiteSettings,
} from '../storage/settingsStore';
import { normalizeHostname } from '../storage/siteKey';
import { getThemeById } from '../themes';

export type PageThemeController = {
  start: () => Promise<void>;
  stop: () => void;
};

const MAX_REAPPLIES_PER_MINUTE = 12;
const MUTATION_WINDOW_MS = 60_000;

function needsLiveObserver(siteSettings: SiteSettings, plan: StrategyPlan): boolean {
  return siteSettings.strategy === 'auto' || plan.strategies.some((id) => id !== 'baseline');
}

export function createPageThemeController(): PageThemeController {
  const siteKey = normalizeHostname(window.location.hostname);
  let stopSettingsListener: (() => void) | null = null;
  let domObserver: DomChangeObserver | null = null;
  let mutationRate = 0;
  let mutationWindowStart = 0;
  let mutationCountInWindow = 0;

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  // Rolling mutation-rate window: a simple counter+windowStart pair rather than
  // a timestamp array, reset whenever the 60s window elapses. Feeds
  // deriveMetrics on the next re-apply so a mutation-heavy page can be steered
  // away from the richer, facts-dependent strategy combinations.
  const registerMutationCallback = (): number => {
    const now = Date.now();
    if (now - mutationWindowStart >= MUTATION_WINDOW_MS) {
      mutationWindowStart = now;
      mutationCountInWindow = 0;
    }
    mutationCountInWindow += 1;
    mutationRate = mutationCountInWindow / (MUTATION_WINDOW_MS / 1000);
    return mutationCountInWindow;
  };

  const ensureDomObserver = (): void => {
    if (domObserver) return;
    mutationWindowStart = Date.now();
    mutationCountInWindow = 0;
    mutationRate = 0;

    domObserver = observeDomChanges(() => {
      const countInWindow = registerMutationCallback();
      if (countInWindow > MAX_REAPPLIES_PER_MINUTE) {
        stopDomObserver();
        console.warn(
          '[Palette Mimicry] re-apply cap reached, pausing live observation until settings change',
        );
        return;
      }

      apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] reapply failed', error);
      });
    });
  };

  const apply = async (): Promise<void> => {
    const siteSettings = await getEffectiveSiteSettings(siteKey);

    if (!siteSettings.enabled) {
      removeStylesheet();
      stopDomObserver();
      return;
    }

    const theme = getThemeById(siteSettings.themeId);
    const facts = collectPageFacts(document);
    const metrics = deriveMetrics(facts, { mutationRate });
    const plan = decideStrategies(metrics, siteSettings.strategy);
    injectStylesheet(composeStylesheet(theme, siteSettings, facts, plan));

    if (needsLiveObserver(siteSettings, plan)) {
      ensureDomObserver();
    } else {
      stopDomObserver();
    }

    await writePlanDiagnostics({ siteKey, plan, metrics, updatedAt: new Date().toISOString() });
  };

  return {
    async start() {
      await apply();
      stopSettingsListener = onSettingsChanged(() => {
        apply().catch((error: unknown) => {
          console.error('[Palette Mimicry] apply failed', error);
        });
      });
    },

    stop() {
      stopSettingsListener?.();
      stopSettingsListener = null;
      stopDomObserver();
    },
  };
}
