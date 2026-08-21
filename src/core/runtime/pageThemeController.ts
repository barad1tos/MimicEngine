import { browser } from 'wxt/browser';
import {
  createSignatureCensus,
  installCensus,
  type SignatureCensus,
} from '../analyzer/signatureCensus';
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

// Census chunk sizes: a synchronous first chunk before the very first apply()
// so computedFallback's first produce() already sees real samples, then
// idle-time chunks for the rest of the page. CENSUS_IDLE_TIMEOUT_MS bounds
// how long a chunk can wait for an idle slot before running anyway.
const CENSUS_FIRST_CHUNK = 800;
const CENSUS_IDLE_CHUNK = 1000;
const CENSUS_IDLE_TIMEOUT_MS = 500;
// Mirrors observeDomChanges' own debounce default (250ms) — kept as an
// independent constant/timer here (censusReapplyTimer) because census
// re-applies are our own work, never page activity, and must never pass
// through registerMutationCallback/capTripped.
const CENSUS_REAPPLY_DEBOUNCE_MS = 250;

function needsLiveObserver(siteSettings: SiteSettings, plan: StrategyPlan): boolean {
  return siteSettings.strategy === 'auto' || planStrategies(plan).some((id) => id !== 'baseline');
}

// requestIdleCallback/cancelIdleCallback are absent in some exotic embeds
// (and in happy-dom, which our tests run under, unless stubbed) even though
// lib.dom declares them unconditionally — the cast below models that actual
// runtime optionality, matching the same feature-detection idiom already
// used for CSS.escape in styleSignature.ts. Re-read from globalThis on every
// call, rather than binding once at module load, so a test's
// vi.stubGlobal(...) — applied per-test, after this module has already been
// imported — still takes effect. The fallback mimics an always-timed-out
// idle deadline via a fixed-delay setTimeout.
type IdleWindow = {
  requestIdleCallback?: typeof requestIdleCallback;
  cancelIdleCallback?: typeof cancelIdleCallback;
};

function scheduleIdleWork(callback: IdleRequestCallback, options: IdleRequestOptions): number {
  const idleCallback = (globalThis as IdleWindow).requestIdleCallback;
  if (idleCallback) return idleCallback(callback, options);
  return window.setTimeout(() => {
    callback({ didTimeout: true, timeRemaining: () => 0 });
  }, options.timeout ?? CENSUS_IDLE_TIMEOUT_MS);
}

function cancelIdleWork(handle: number): void {
  const cancelCallback = (globalThis as IdleWindow).cancelIdleCallback;
  if (cancelCallback) {
    cancelCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

// Flattens the direct top-level element additions out of a mutation batch.
// A module-level function (rather than a closure nested inside the
// MutationObserver callback) so the census mutation observer below stays
// within sonarjs' nesting-depth limit.
function addedElementsFrom(records: readonly MutationRecord[]): Element[] {
  const elements: Element[] = [];
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) elements.push(node);
    }
  }
  return elements;
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
  // walk on every apply would tax every page, deepRemap or not. Always false
  // for a fresh controller instance, even when a previous instance (e.g. a
  // re-injection into a still-live page) left shadow styles behind — see
  // firstApplyCompleted below for how that orphan gets cleaned up anyway.
  let shadowStylesActive = false;
  // Flips true once this controller instance's first apply() completes past
  // the generation guard (whichever branch it takes). Lets that one apply —
  // and only that one — run an unconditional shadow-tree sweep whenever it
  // removes shadow styles without also syncing new ones (disabled site or a
  // plan without deepRemap), self-healing any orphaned shadow styles a
  // previous controller instance left behind; every apply after that falls
  // back to the cheap shadowStylesActive-guarded path. See
  // deactivateOrSweepShadowStyles below.
  let firstApplyCompleted = false;
  // Set by stop(); checked by start() after its initial apply() settles, so
  // a stop() that lands while that apply() is still stalled (e.g. on the
  // settings read) stops start() from registering onSettingsChanged
  // afterward and leaking a listener on an already-stopped controller.
  let stopped = false;
  // The live census this controller instance owns. installedCensus() (read by
  // computedFallback.produce at apply() time) mirrors this exactly: installed
  // on start(), cleared on stop() — never left dangling for a dead instance.
  let census: SignatureCensus | null = null;
  // Dedicated cancellation token for the census idle-chunk loop — deliberately
  // separate from applyGeneration. Every apply() (including the census's own
  // 250ms debounced re-apply) bumps applyGeneration; piggybacking the chunk
  // loop on it meant the loop could self-strand after its own reapply fired
  // before the next idle callback (reproduced: a 2500-element walk stopping
  // dead at ~801 elements, complete forever false). Only stop() and a fresh
  // start() bump censusGeneration, so ordinary apply() activity is entirely
  // irrelevant to whether the walk continues.
  let censusGeneration = 0;
  // Handle for the next scheduleCensusChunk() idle callback, so stop() can
  // cancel it — a stale idle callback from a previous generation must never
  // resume census work after teardown.
  let censusIdleHandle: number | null = null;
  // Own debounce timer for census-driven re-applies (scheduleCensusReapply),
  // distinct from observeDomChanges' internal debounce: this one must never
  // touch registerMutationCallback/capTripped, since census progress is our
  // own work, not page activity.
  let censusReapplyTimer: number | undefined;
  // A MutationObserver dedicated to census learning, independent of
  // domObserver: domObserver is only created (via ensureDomObserver) when the
  // current plan needs live re-theming, and its re-applies are mutation-rate
  // capped. Census progress must keep learning from page mutations for the
  // controller's whole lifetime regardless of the current plan or cap state,
  // so this observer is unconditional and its own reapply path is exempt
  // from the rate recorder.
  let censusObserver: MutationObserver | null = null;
  // The most recent plan any apply() call decided — read only to gate
  // whether a census-driven reapply is worth scheduling at all: recomposing
  // when the plan doesn't include computedFallback is a guaranteed no-op,
  // since that's the only strategy that reads census output. Set at the end
  // of every apply() that reaches decideStrategies (never in the
  // disabled-site early return, where no plan is decided at all). Null until
  // the first such apply() completes.
  let lastPlan: StrategyPlan | null = null;

  const stopDomObserver = (): void => {
    domObserver?.stop();
    domObserver = null;
  };

  const stopCensusObserver = (): void => {
    censusObserver?.disconnect();
    censusObserver = null;
  };

  // Debounced re-apply for census progress alone. A dedicated timer (not
  // observeDomChanges' internal one) so chunk completion never counts toward
  // the per-minute mutation cap — the census converging is our own work, not
  // page activity, and must never trip capTripped.
  const scheduleCensusReapply = (): void => {
    if (censusReapplyTimer !== undefined) window.clearTimeout(censusReapplyTimer);
    censusReapplyTimer = window.setTimeout(() => {
      censusReapplyTimer = undefined;
      apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] census re-apply failed', error);
      });
    }, CENSUS_REAPPLY_DEBOUNCE_MS);
  };

  // Recomposing after census progress is a guaranteed no-op unless the
  // current plan actually reads census output — computedFallback is the
  // only strategy that does. Both the chunk-completion path and the
  // ingest-learned path gate their reapply scheduling on this.
  const planIncludesComputedFallback = (): boolean =>
    lastPlan !== null && planStrategies(lastPlan).includes('computedFallback');

  // Drives the census to completion one idle-time chunk at a time. The
  // censusGeneration captured here (not applyGeneration — see its
  // declaration above) is checked when the idle callback actually fires:
  // stop() bumps censusGeneration as part of its census teardown, so a chunk
  // whose idle callback lands after stop() sees a mismatch and aborts
  // instead of resuming census work on a torn-down controller. Ordinary
  // apply() traffic never touches censusGeneration, so it never interrupts
  // the walk.
  const scheduleCensusChunk = (): void => {
    if (!census) return;
    const generation = censusGeneration;
    censusIdleHandle = scheduleIdleWork(
      () => {
        censusIdleHandle = null;
        if (generation !== censusGeneration || !census) return;
        const done = census.advance(CENSUS_IDLE_CHUNK);
        // Recompose is a no-op unless the current plan reads census output —
        // see planIncludesComputedFallback above.
        if (planIncludesComputedFallback()) scheduleCensusReapply();
        if (!done) scheduleCensusChunk();
      },
      { timeout: CENSUS_IDLE_TIMEOUT_MS },
    );
  };

  // Routes newly added elements through the census so it keeps learning
  // after its initial traversal (SPA-style DOM churn, lazy-rendered content).
  // Deliberately separate from domObserver/observeDomChanges: that observer
  // is gated on the current plan needing live re-theming and its callback
  // carries no element data, while census learning must run unconditionally
  // for the controller's whole lifetime. ingestAddedElements walks each
  // added element's own subtree, so only the direct top-level additions are
  // passed through here.
  const observeCensusMutations = (): MutationObserver => {
    const observer = new MutationObserver((records) => {
      if (!census) return;
      const addedElements = addedElementsFrom(records);
      if (addedElements.length === 0) return;
      // Ingest always runs, tripped cap or not: learning only ever updates
      // the census's own in-memory record — it never injects a stylesheet
      // or otherwise side-effects the page — so there is nothing here for
      // the cap to protect against. Gating ingest itself on capTripped (the
      // previous behavior) meant every element added during a storm window
      // was permanently invisible to the census: apply() never re-ingests
      // anything on its own, so a later settings change clearing capTripped
      // does not recover what was skipped. Only recomposing
      // (scheduleCensusReapply) touches the live page, which is why that
      // alone stays gated on capTripped — mirroring ensureDomObserver's own
      // cap gate, this observer must not become a side channel that keeps
      // recomposing during a storm the cap already decided to silence.
      const learned = census.ingestAddedElements(addedElements);
      // Recompose only when this batch actually taught the census something
      // new, the cap isn't currently silencing reapplies, AND the current
      // plan would actually read the census (computedFallback is the only
      // strategy that does — see planIncludesComputedFallback above).
      if (learned && !capTripped && planIncludesComputedFallback()) scheduleCensusReapply();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return observer;
  };

  const deactivateShadowStyles = (): void => {
    if (!shadowStylesActive) return;
    removeShadowStylesheets(document);
    shadowStylesActive = false;
  };

  // ORPHAN SELF-HEAL, shared by every apply() branch that removes shadow
  // styles without also syncing new ones (the disabled-site path and the
  // plan-without-deepRemap path): the cheap shadowStylesActive-guarded path
  // once this instance's first apply has completed, or one unconditional
  // sweep on that first apply itself. shadowStylesActive always starts false
  // for a fresh controller instance — even when a previous instance (e.g. a
  // re-injection into a still-live page) left shadow styles behind, disabled
  // site or not — so the guarded path alone would never catch that orphan.
  const deactivateOrSweepShadowStyles = (): void => {
    if (firstApplyCompleted) {
      deactivateShadowStyles();
    } else {
      removeShadowStylesheets(document);
    }
    firstApplyCompleted = true;
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
      deactivateOrSweepShadowStyles();
      stopDomObserver();
      // Census machinery matters only for a live, enabled page — nothing
      // can read its output while disabled, so mirror stop()'s census
      // teardown here rather than leaving the walk (and its idle chunks and
      // debounced reapplies) running for no reason.
      if (censusIdleHandle !== null) cancelIdleWork(censusIdleHandle);
      censusIdleHandle = null;
      if (censusReapplyTimer !== undefined) window.clearTimeout(censusReapplyTimer);
      censusReapplyTimer = undefined;
      installCensus(null);
      census = null;
      return;
    }

    const theme = resolveTheme(siteSettings.themeId, importedThemes);
    const facts = collectPageFacts(document);
    const metrics = deriveMetrics(facts, { mutationRate });
    const plan = decideStrategies(metrics, siteSettings.strategy);
    lastPlan = plan;
    const { css, coverages } = composeStylesheet(theme, siteSettings, facts, plan);
    injectStylesheet(css);

    if (planStrategies(plan).includes('deepRemap')) {
      syncShadowStylesheets(buildShadowStylesheet(theme), collectOpenShadowRoots(document));
      shadowStylesActive = true;
      firstApplyCompleted = true;
      // No extra sweep needed here even on the first apply: the sync above
      // already overwrites (by element id) any shadow style content a
      // previous controller instance left behind in these roots.
    } else {
      deactivateOrSweepShadowStyles();
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
    const censusSnapshot = census?.snapshot();
    await writePlanDiagnostics({
      siteKey,
      plan,
      metrics,
      ...(coverage && { coverage }),
      ...(censusSnapshot
        ? {
            census: {
              complete: censusSnapshot.complete,
              signatureCount: censusSnapshot.signatureCount,
              elementsVisited: censusSnapshot.elementsVisited,
              droppedProperties: censusSnapshot.droppedProperties,
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    async start() {
      // Synchronous setup, before the initial apply(): begin the census and
      // advance its first chunk synchronously so that first apply()'s
      // computedFallback.produce() (reading installedCensus()) already sees
      // real samples, not an empty snapshot. The census mutation observer
      // starts here too, before any await, so no page mutation during the
      // settings read below can slip past it. Bumping censusGeneration here
      // (defense in depth, mirroring stop()'s bump) invalidates any idle
      // chunk a previous start() on this same instance might still have
      // pending.
      censusGeneration += 1;
      census = createSignatureCensus();
      census.begin(document);
      const firstChunkComplete = census.advance(CENSUS_FIRST_CHUNK);
      installCensus(census);
      censusObserver = observeCensusMutations();

      // A throwing initial apply() must not stop start() itself from
      // completing: the settings-changed listener below still needs to be
      // registered, and (in the real content-script entry point) so does the
      // pagehide listener registered right after `await controller.start()`
      // returns — neither should be skipped just because the very first
      // apply failed (e.g. a transient storage read error).
      await apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] initial apply failed', error);
      });
      // LISTENER-AFTER-STOP: stop() may have run while the initial apply()
      // above was still in flight (e.g. stalled on the settings read) — its
      // generation guard already aborts that apply()'s own side effects, but
      // without this check start() would still register the
      // settings-changed listener afterward, leaking it on an
      // already-stopped controller. The same guard covers scheduling the
      // first census idle chunk below.
      if (stopped) return;
      stopSettingsListener = onSettingsChanged(() => {
        capTripped = false;
        mutationWindowStart = 0;
        mutationCountInWindow = 0;
        mutationRate = 0;
        apply().catch((error: unknown) => {
          console.error('[Palette Mimicry] apply failed', error);
        });
      });
      if (!firstChunkComplete) scheduleCensusChunk();
    },

    stop() {
      // Invalidate any apply() still in flight (e.g. stalled on the settings
      // read) before tearing anything else down — its post-await generation
      // re-check then fails and it aborts before re-injecting the
      // stylesheet, re-setting data-pm-active, or re-syncing shadow styles.
      applyGeneration += 1;
      // Separate token for the census idle-chunk loop (see its declaration
      // above): a pending chunk's own censusGeneration check fails right
      // after this bump, so no chunk survives stop() even though ordinary
      // apply() traffic never touches this counter.
      censusGeneration += 1;
      // Set before start() can observe it — see the LISTENER-AFTER-STOP note
      // on start() above.
      stopped = true;
      stopSettingsListener?.();
      stopSettingsListener = null;
      stopDomObserver();
      stopCensusObserver();
      if (censusIdleHandle !== null) cancelIdleWork(censusIdleHandle);
      censusIdleHandle = null;
      if (censusReapplyTimer !== undefined) window.clearTimeout(censusReapplyTimer);
      censusReapplyTimer = undefined;
      installCensus(null);
      census = null;
      // BFCACHE SYMMETRY RULING: stop() deliberately leaves shadow styles in
      // place, same as it already leaves the document stylesheet and the
      // data-pm-active gate untouched. A bfcache-restored page shows a fully
      // themed static page; removing only the shadow styles here used to
      // leave it themed-document/unthemed-shadow instead. Teardown stays
      // complete on the other two removal paths inside apply() (the disable
      // path and the plan-switch-away-from-deepRemap path); any shadow
      // styles a now-dead controller instance leaves behind are the orphan
      // self-heal's job (see firstApplyCompleted above), not stop()'s.
    },
  };
}
