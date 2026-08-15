import { composeStylesheet } from '../engine/composeStylesheet';
import { buildColorMapping, extractSitePalette } from '../engine/colorMap';
import { computeCoverage } from '../engine/coverage';
import { decideStrategies, type StrategyPlan } from '../engine/decisionTable';
import { writePlanDiagnostics } from '../engine/diagnostics';
import { collectPageFacts } from '../engine/pageFacts';
import { deriveMetrics } from '../engine/pageMetrics';
import { guardContrast } from '../engine/contrastGuard';
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
  // Set once the cap trips; stays true (blocking observer re-creation, even
  // from an apply() that started before the trip and resolves after it) until
  // the settings-changed handler clears it. See the cap-revival race note below.
  let capTripped = false;
  let mutationRate = 0;
  let mutationWindowStart = 0;
  let mutationCountInWindow = 0;

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  // Rolling mutation-rate window: a simple counter+windowStart pair rather than
  // a timestamp array, reset whenever the 60s window elapses. mutationRate is
  // expressed as callbacks per minute (the window IS a minute), so it reads
  // directly against the decision table's calm-page thresholds. Feeds
  // deriveMetrics on the next re-apply so a mutation-heavy page can be steered
  // away from the richer, facts-dependent strategy combinations.
  const registerMutationCallback = (): number => {
    const now = Date.now();
    if (now - mutationWindowStart >= MUTATION_WINDOW_MS) {
      mutationWindowStart = now;
      mutationCountInWindow = 0;
    }
    mutationCountInWindow += 1;
    mutationRate = mutationCountInWindow;
    return mutationCountInWindow;
  };

  // Gated on capTripped (not just domObserver === null): without this gate, an
  // apply() that started before the cap tripped can resolve afterward, still
  // see domObserver === null, and re-create the observer — silently defeating
  // the cap and breaking the single-warn guarantee. capTripped only clears in
  // the settings-changed handler, so the observer stays off until then.
  const ensureDomObserver = (): void => {
    if (capTripped || domObserver) return;

    domObserver = observeDomChanges(() => {
      const countInWindow = registerMutationCallback();
      if (countInWindow > MAX_REAPPLIES_PER_MINUTE) {
        capTripped = true;
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

    let coverage;
    if (plan.strategies.includes('authoredRemap') || plan.strategies.includes('computedFallback')) {
      const palette = extractSitePalette(facts);
      const mapping = guardContrast(
        buildColorMapping(palette, theme, {
          preserveBrandColors: siteSettings.preserveBrandColors,
        }),
        palette,
        theme,
      ).mapping;
      coverage = computeCoverage(palette, mapping);
    }

    await writePlanDiagnostics({
      siteKey,
      plan,
      metrics,
      ...(coverage && { coverage }),
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    async start() {
      await apply();
      stopSettingsListener = onSettingsChanged(() => {
        capTripped = false;
        mutationWindowStart = 0;
        mutationCountInWindow = 0;
        mutationRate = 0;
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
