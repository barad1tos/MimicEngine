import { buildBaseStylesheet } from '../injector/buildBaseStylesheet';
import { injectStylesheet, removeStylesheet } from '../injector/styleElement';
import { getThemeById } from '../themes';
import { observeDomChanges, type DomChangeObserver } from '../live/observeDomChanges';
import { collectComputedColors } from '../analyzer/collectComputedColors';
import { getEffectiveSiteSettings, onSettingsChanged } from '../storage/settingsStore';
import { normalizeHostname } from '../storage/siteKey';

export type PageThemeController = {
  start: () => Promise<void>;
  stop: () => void;
};

export function createPageThemeController(): PageThemeController {
  const siteKey = normalizeHostname(window.location.hostname);
  let stopSettingsListener: (() => void) | null = null;
  let domObserver: DomChangeObserver | null = null;

  async function apply() {
    const siteSettings = await getEffectiveSiteSettings(siteKey);

    if (!siteSettings.enabled || siteSettings.mode === 'off') {
      removeStylesheet();
      stopDomObserver();
      return;
    }

    const theme = getThemeById(siteSettings.themeId);
    const stylesheet = buildBaseStylesheet(theme, siteSettings);
    injectStylesheet(stylesheet);

    if (siteSettings.mode === 'semantic' || siteSettings.mode === 'aggressive') {
      ensureDomObserver();
      // Foundation only: this proves the analyzer can run without changing behavior yet.
      collectComputedColors(document, { maxElements: 300 });
    } else {
      stopDomObserver();
    }
  }

  function ensureDomObserver() {
    if (domObserver) return;
    domObserver = observeDomChanges(() => {
      apply().catch((error: unknown) => console.error('[Palette Mimicry] reapply failed', error));
    });
  }

  function stopDomObserver() {
    domObserver?.stop();
    domObserver = null;
  }

  return {
    async start() {
      await apply();
      stopSettingsListener = onSettingsChanged(() => {
        apply().catch((error: unknown) => console.error('[Palette Mimicry] apply failed', error));
      });
    },

    stop() {
      stopSettingsListener?.();
      stopSettingsListener = null;
      stopDomObserver();
    },
  };
}
