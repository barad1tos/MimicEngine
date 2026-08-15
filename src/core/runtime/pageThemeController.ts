import { composeStylesheet } from '../engine/composeStylesheet';
import { decideStrategies } from '../engine/decisionTable';
import { writePlanDiagnostics } from '../engine/diagnostics';
import { collectPageFacts } from '../engine/pageFacts';
import { deriveMetrics } from '../engine/pageMetrics';
import { injectStylesheet, removeStylesheet } from '../injector/styleElement';
import { observeDomChanges, type DomChangeObserver } from '../live/observeDomChanges';
import { getEffectiveSiteSettings, onSettingsChanged } from '../storage/settingsStore';
import { normalizeHostname } from '../storage/siteKey';
import { getThemeById } from '../themes';

export type PageThemeController = {
  start: () => Promise<void>;
  stop: () => void;
};

export function createPageThemeController(): PageThemeController {
  const siteKey = normalizeHostname(window.location.hostname);
  let stopSettingsListener: (() => void) | null = null;
  let domObserver: DomChangeObserver | null = null;

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  const ensureDomObserver = (): void => {
    if (domObserver) return;
    domObserver = observeDomChanges(() => {
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
    const metrics = deriveMetrics(facts);
    const plan = decideStrategies(metrics, siteSettings.strategy);
    injectStylesheet(composeStylesheet(theme, siteSettings, facts, plan));

    if (plan.strategies.includes('variableRemap')) {
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
