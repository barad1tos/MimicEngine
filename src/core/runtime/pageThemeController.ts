import { browser } from 'wxt/browser';
import { collectPageFacts } from '../engine/pageFacts';
import { composeStylesheet } from '../engine/composeStylesheet';
import { aggregateCoverage } from '../engine/coverage';
import { decideStrategies, planStrategies, type StrategyPlan } from '../engine/decisionTable';
import { deriveMetrics } from '../engine/pageMetrics';
import { writePlanDiagnostics } from '../engine/diagnostics';
import {
  buildShadowStylesheet,
  collectOpenShadowRoots,
  removeShadowStylesheets,
  syncShadowStylesheets,
} from '../injector/shadowStyles';
import { injectStylesheet, removeStylesheet } from '../injector/styleElement';
import { observeDomChanges, type DomChangeObserver } from '../live/observeDomChanges';
import {
  IMPORTED_THEMES_KEY,
  normalizeImportedThemes,
  type ImportedTheme,
} from '../storage/importedThemesStore';
import {
  deriveEffectiveSiteSettings,
  normalizeSettings,
  onSettingsChanged,
  STORAGE_KEY,
  type SiteSettings,
} from '../storage/settingsStore';
import { normalizeHostname } from '../storage/siteKey';
import { resolveTheme } from '../themes';

export type PageThemeController = {
  start: () => Promise<void>;
  stop: () => void;
};

const MAX_REAPPLIES_PER_MINUTE = 12;
const MUTATION_WINDOW_MS = 60_000;

function needsLiveObserver(siteSettings: SiteSettings, plan: StrategyPlan): boolean {
  return siteSettings.strategy === 'auto' || planStrategies(plan).some((id) => id !== 'baseline');
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
  // Monotonically increasing, captured at the start of each apply() call.
  // Guards against an older apply() — stalled on the settings read — resuming
  // after a newer apply() has already injected its stylesheet and written its
  // diagnostics; without this, the stale call would silently overwrite both
  // with outdated results (see the generation-guard controller test). stop()
  // also bumps this counter (before its own teardown) so an apply() still
  // stalled on the settings read at stop time fails its post-await
  // generation check and aborts instead of reactivating styling after an
  // explicit stop.
  let applyGeneration = 0;
  // Tracks whether the previous apply() left our style element in every open
  // shadow root, so a plan without deepRemap only walks the shadow tree to
  // remove it when there's actually something to remove — an unconditional
  // walk on every apply would tax every page, deepRemap or not.
  let shadowStylesActive = false;

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  const deactivateShadowStyles = (): void => {
    if (!shadowStylesActive) return;
    removeShadowStylesheets(document);
    shadowStylesActive = false;
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

  // Single batched read backing apply(): settings and imported themes live
  // under separate storage.local keys, but the engine pipeline needs both
  // before it can decide anything, so one browser.storage.local.get([...])
  // call fetches both raw values and this funnels them through the same
  // normalization every other reader uses (normalizeSettings,
  // normalizeImportedThemes) rather than trusting the raw storage shape.
  const readApplyInputs = async (): Promise<{
    siteSettings: SiteSettings;
    importedThemes: readonly ImportedTheme[];
  }> => {
    const raw = await browser.storage.local.get([STORAGE_KEY, IMPORTED_THEMES_KEY]);
    const settings = normalizeSettings(raw[STORAGE_KEY]);

    return {
      siteSettings: deriveEffectiveSiteSettings(settings, siteKey),
      importedThemes: normalizeImportedThemes(raw[IMPORTED_THEMES_KEY]).themes,
    };
  };

  const apply = async (): Promise<void> => {
    const generation = ++applyGeneration;
    const { siteSettings, importedThemes } = await readApplyInputs();
    // A newer apply() started while this one awaited settings — its
    // stylesheet and diagnostics are already current; proceeding here would
    // overwrite them with this call's now-stale results.
    if (generation !== applyGeneration) return;

    if (!siteSettings.enabled) {
      removeStylesheet();
      deactivateShadowStyles();
      stopDomObserver();
      return;
    }

    const theme = resolveTheme(siteSettings.themeId, importedThemes);
    const facts = collectPageFacts(document);
    const metrics = deriveMetrics(facts, { mutationRate });
    const plan = decideStrategies(metrics, siteSettings.strategy);
    const { css, coverages } = composeStylesheet(theme, siteSettings, facts, plan);
    injectStylesheet(css);

    if (planStrategies(plan).includes('deepRemap')) {
      syncShadowStylesheets(buildShadowStylesheet(theme), collectOpenShadowRoots(document));
      shadowStylesActive = true;
    } else {
      deactivateShadowStyles();
    }

    if (needsLiveObserver(siteSettings, plan)) {
      ensureDomObserver();
    } else {
      stopDomObserver();
    }

    // Each strategy now owns its own coverage measurement (see registry.ts'
    // StrategyOutput); composeStylesheet collects whatever the selected
    // strategies reported, and aggregateCoverage merges them into one report
    // — or undefined when none of them measured anything.
    const coverage = aggregateCoverage(coverages);

    // Defensive re-check before the diagnostics write itself: everything
    // above this line is synchronous (no further yield point can let a
    // newer generation start), so this is currently unreachable in practice,
    // but it keeps the guard's contract — abort before every listed side
    // effect, including diagnostics — true even if that changes later.
    if (generation !== applyGeneration) return;
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
      // A throwing initial apply() must not stop start() itself from
      // completing: the settings-changed listener below still needs to be
      // registered, and (in the real content-script entry point) so does the
      // pagehide listener registered right after `await controller.start()`
      // returns — neither should be skipped just because the very first
      // apply failed (e.g. a transient storage read error).
      await apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] initial apply failed', error);
      });
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
      // Invalidate any apply() still in flight (e.g. stalled on the settings
      // read) before tearing anything else down — its post-await generation
      // re-check then fails and it aborts before re-injecting the
      // stylesheet, re-setting data-pm-active, or re-syncing shadow styles.
      applyGeneration += 1;
      stopSettingsListener?.();
      stopSettingsListener = null;
      stopDomObserver();
      deactivateShadowStyles();
    },
  };
}
