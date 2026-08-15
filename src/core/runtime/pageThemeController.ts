import { buildBaseStylesheet } from '../injector/buildBaseStylesheet';
import { injectStylesheet, removeStylesheet } from '../injector/styleElement';
import { getThemeById } from '../themes';
import type { DomChangeObserver } from '../live/observeDomChanges';
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

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  const apply = async (): Promise<void> => {
    const siteSettings = await getEffectiveSiteSettings(siteKey);

    if (!siteSettings.enabled) {
      removeStylesheet();
      stopDomObserver();
      return;
    }

    const theme = getThemeById(siteSettings.themeId);
    const stylesheet = buildBaseStylesheet(theme);
    injectStylesheet(stylesheet);
    stopDomObserver();
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
