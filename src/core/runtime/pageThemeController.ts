import { browser } from 'wxt/browser';
import {
  createSignatureCensus,
  installCensus,
  type SignatureCensus,
} from '../analyzer/signatureCensus';
import { buildBootstrapStylesheet } from '../engine/buildBootstrapStylesheet';
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
import { injectStylesheet, isOwnElement, removeStylesheet } from '../injector/styleElement';
import {
  observeDomChanges,
  SIGNIFICANT_ATTRIBUTES,
  type DomChangeObserver,
} from '../live/observeDomChanges';
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
import {
  readCachedStylesheet,
  writeCachedStylesheet,
  type StyleCacheContext,
} from '../storage/stylesheetCache';
import { resolveTheme, type PaletteTheme } from '../themes';
import { waitForDocumentReady } from './documentReady';

export type PageThemeController = {
  start: () => Promise<void>;
  stop: () => void;
};

const MAX_REAPPLIES_PER_MINUTE = 12;
const MUTATION_WINDOW_MS = 60_000;

// Census chunk sizes: a synchronous first chunk identifies small pages that
// can publish a complete census before the first apply. Larger pages keep the
// incomplete walk private, then publish it after the remaining idle chunks
// converge. CENSUS_IDLE_TIMEOUT_MS bounds how long an idle chunk can wait.
const CENSUS_FIRST_CHUNK = 800;
const CENSUS_IDLE_CHUNK = 1000;
const CENSUS_IDLE_TIMEOUT_MS = 500;
// A slightly wider settle window than observeDomChanges' 250ms debounce lets
// a late loading burst invalidate a just-completed census before its CSS is
// exposed. This remains an independent timer because census re-applies are
// our own work and must never pass through the page-mutation rate recorder.
const CENSUS_REAPPLY_DEBOUNCE_MS = 500;
const CENSUS_MAX_SETTLE_MS = 1500;

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

// Flattens the direct top-level element additions out of a mutation batch,
// excluding our own elements (isOwnElement) — withStylesheetDisabled's
// transition-kill element churns document.documentElement's childList around
// every census read (advance/ingestAddedElements both wrap themselves in it),
// and feeding that churn back into ingestAddedElements would recurse without
// end: ingest calls withStylesheetDisabled itself, which churns the kill
// element again, producing another batch for this same observer. A
// module-level function (rather than a closure nested inside the
// MutationObserver callback) so the census mutation observer below stays
// within sonarjs' nesting-depth limit.
function addedElementsFrom(records: readonly MutationRecord[]): Element[] {
  const elements: Element[] = [];
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element && !isOwnElement(node)) elements.push(node);
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
  // Set by stop(); checked across both asynchronous startup boundaries so a
  // stopped controller never installs live observers or listeners afterward.
  let stopped = false;
  const isStopped = (): boolean => stopped;
  // The live census this controller instance owns. installedCensus() (read by
  // computedFallback.produce at apply() time) mirrors this exactly: installed
  // on start(), cleared on stop() — never left dangling for a dead instance.
  let census: SignatureCensus | null = null;
  // The census currently visible to computedFallback. During an attribute-
  // driven refresh, census points at the replacement walk while this keeps
  // the last complete snapshot installed until the replacement converges.
  let publishedCensus: SignatureCensus | null = null;
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
  // Own debounce timer for census publication (scheduleCensusPublish),
  // distinct from observeDomChanges' internal debounce: this one must never
  // touch registerMutationCallback/capTripped, since census progress is our
  // own work, not page activity.
  let censusReapplyTimer: number | undefined;
  // Starts with the first publication request in a burst and survives every
  // debounce reset. The hard ceiling prevents a continuously mutating page
  // from withholding its completed census forever.
  let censusSettleStartedAt: number | null = null;
  // A MutationObserver dedicated to census learning, independent of
  // domObserver: domObserver is only created (via ensureDomObserver) when the
  // current plan needs live re-theming, and its re-applies are mutation-rate
  // capped. Census progress must keep learning from page mutations for the
  // controller's whole lifetime regardless of the current plan or cap state,
  // so this observer is unconditional and its own reapply path is exempt
  // from the rate recorder.
  let censusObserver: MutationObserver | null = null;
  // Set by observeCensusMutations on any significant attribute mutation
  // (class/style/data-theme/aria-hidden — SIGNIFICANT_ATTRIBUTES, the same
  // list domObserver reacts to): an SPA-style class/theme flip can change a
  // descendant's COMPUTED color without adding or removing any node, and the
  // census's grow-only value Sets have no way to represent "this color
  // changed" — re-sampling in place would just look like divergence.
  // scheduleCensusPublish's debounced callback is the only place this is
  // read; it discards and re-bootstraps the census (a fresh full walk)
  // instead of resuming the stale one, then clears the flag.
  let censusStale = false;
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

  const clearCensus = (): void => {
    if (censusIdleHandle !== null) cancelIdleWork(censusIdleHandle);
    censusIdleHandle = null;
    if (censusReapplyTimer !== undefined) window.clearTimeout(censusReapplyTimer);
    censusReapplyTimer = undefined;
    censusSettleStartedAt = null;
    installCensus(null);
    census = null;
    publishedCensus = null;
  };

  // Debounced publication for census progress alone. A dedicated timer (not
  // observeDomChanges' internal one) keeps an incomplete census private and
  // prevents convergence from counting toward the page-mutation cap.
  const scheduleCensusPublish = (): void => {
    const now = Date.now();
    censusSettleStartedAt ??= now;
    const elapsed = now - censusSettleStartedAt;
    const delay = Math.min(CENSUS_REAPPLY_DEBOUNCE_MS, CENSUS_MAX_SETTLE_MS - elapsed);
    if (censusReapplyTimer !== undefined) window.clearTimeout(censusReapplyTimer);
    censusReapplyTimer = window.setTimeout(
      () => {
        censusReapplyTimer = undefined;
        if (censusStale) {
          // A significant attribute mutation invalidated the census's grow-only
          // value Sets (see censusStale's declaration above) — the only correct
          // recovery is to discard and re-bootstrap rather than resume the
          // stale one.
          if (censusIdleHandle !== null) cancelIdleWork(censusIdleHandle);
          censusIdleHandle = null;
          census = null;
          const refreshComplete = bootstrapCensus();
          censusStale = false;
          if (!refreshComplete) return;
          scheduleCensusPublish();
          return;
        }
        publishCensus();
        censusSettleStartedAt = null;
        if (!planIncludesComputedFallback()) return;
        apply().catch((error: unknown) => {
          console.error('[Palette Mimicry] census publish failed', error);
        });
      },
      Math.max(0, delay),
    );
  };

  // Recomposing after census progress is a guaranteed no-op unless the
  // current plan actually reads census output — computedFallback is the
  // only strategy that does. Publication still happens for every completed
  // walk so a later plan switch never inherits an incomplete census.
  const planIncludesComputedFallback = (): boolean =>
    lastPlan !== null && planStrategies(lastPlan).includes('computedFallback');

  const publishCensus = (): void => {
    if (!census) return;
    publishedCensus = census;
    installCensus(census);
  };

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
        // Publish one converged result instead of exposing every intermediate
        // chunk as a visibly different stylesheet while the walk is ongoing.
        if (done && !censusStale) scheduleCensusPublish();
        if (!done) scheduleCensusChunk();
      },
      { timeout: CENSUS_IDLE_TIMEOUT_MS },
    );
  };

  // Creates a fresh census, walks its synchronous first chunk, and schedules
  // the remaining idle-time chunks if the walk didn't finish synchronously.
  // The caller publishes a synchronous completion; async completion goes
  // through scheduleCensusPublish's settle window. Called once
  // from start(), and again — lazily — from apply()'s enabled branch
  // whenever census is null: a site disabled mid-session tears the census
  // down entirely (see the disabled branch below), so re-enabling it later
  // in the same page lifetime must get a fresh walk here rather than
  // computedFallback reading a permanently empty census until the next full
  // page load. Bumping censusGeneration (defense in depth, mirroring
  // stop()'s bump) invalidates any idle chunk a previous bootstrap on this
  // same instance might still have pending — harmless when there isn't one.
  const bootstrapCensus = (): boolean => {
    censusGeneration += 1;
    census = createSignatureCensus();
    census.begin(document);
    const firstChunkComplete = census.advance(CENSUS_FIRST_CHUNK);
    if (!firstChunkComplete) scheduleCensusChunk();
    return firstChunkComplete;
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

      // A significant attribute mutation (class/style/data-theme/aria-hidden
      // — mirrors domObserver's own SIGNIFICANT_ATTRIBUTES) can change a
      // descendant's COMPUTED color without adding or removing any node.
      // The census cannot re-sample in place (its grow-only value Sets have
      // no way to represent "this color changed"), so mark it stale instead
      // of walking/ingesting the mutated targets — scheduleCensusPublish's
      // debounced callback resets to a fresh full walk once it actually
      // fires. Gated the same as the ingest-learned path below: only worth
      // scheduling when the cap isn't silencing reapplies and the current
      // plan would actually read the census.
      if (records.some((record) => record.type === 'attributes')) {
        censusStale = true;
        if (!capTripped && planIncludesComputedFallback()) scheduleCensusPublish();
      }

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
      // (scheduleCensusPublish) touches the live page, which is why that
      // alone stays gated on capTripped — mirroring ensureDomObserver's own
      // cap gate, this observer must not become a side channel that keeps
      // recomposing during a storm the cap already decided to silence.
      const learned = census.ingestAddedElements(addedElements);
      // Recompose only when this batch actually taught the census something
      // new, the cap isn't currently silencing reapplies, AND the current
      // plan would actually read the census (computedFallback is the only
      // strategy that does — see planIncludesComputedFallback above).
      if (learned && census === publishedCensus && !capTripped && planIncludesComputedFallback()) {
        scheduleCensusPublish();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...SIGNIFICANT_ATTRIBUTES],
    });
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

  const cacheContext = (theme: PaletteTheme, settings: SiteSettings): StyleCacheContext => ({
    siteKey,
    pathname: window.location.pathname,
    theme,
    settings,
  });

  const publishBootstrap = async (): Promise<void> => {
    const generation = ++applyGeneration;
    const { siteSettings, importedThemes } = await readApplyInputs();
    if (generation !== applyGeneration || stopped) return;

    if (!siteSettings.enabled) {
      removeStylesheet();
      return;
    }

    const theme = resolveTheme(siteSettings.themeId, importedThemes);
    const cachedCss = await readCachedStylesheet(cacheContext(theme, siteSettings));
    if (generation !== applyGeneration || isStopped()) return;
    injectStylesheet(cachedCss ?? buildBootstrapStylesheet(theme, siteSettings));
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
      clearCensus();
      return;
    }

    // A site re-enabled mid-session (via a settings change) after the
    // disabled branch above tore its census down finds census null here —
    // bootstrap a fresh one before composing so computedFallback sees real
    // samples again in this same apply(), rather than reading a permanently
    // empty census until the next full page load. The `!stopped` check is
    // defense in depth: the generation guard just above already means
    // stop() cannot have run since this apply() call's own generation was
    // assigned, but this keeps the guard's contract explicit even if that
    // changes later. Guarded by `!census` so an already-bootstrapped census
    // (the common case) is never recreated.
    if (!census && !stopped && bootstrapCensus()) scheduleCensusPublish();

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
    const censusSnapshot = publishedCensus?.snapshot();
    const shouldCacheStylesheet =
      census === publishedCensus &&
      censusSnapshot?.complete === true &&
      planStrategies(plan).includes('computedFallback');
    const currentCacheContext = cacheContext(theme, siteSettings);
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
    if (generation !== applyGeneration || !shouldCacheStylesheet) return;
    await writeCachedStylesheet(currentCacheContext, css);
  };

  const startSettingsListener = (): void => {
    stopSettingsListener = onSettingsChanged(() => {
      capTripped = false;
      mutationWindowStart = 0;
      mutationCountInWindow = 0;
      mutationRate = 0;
      apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] apply failed', error);
      });
      // A significant attribute mutation during a cap-tripped window sets
      // censusStale, but scheduleCensusPublish is gated on !capTripped, so
      // it was never called — the flag would otherwise sit unconsumed
      // until some unrelated mutation happens to fire the census observer
      // again, leaving computedFallback serving stale samples silently in
      // the meantime. The cap just cleared above, so this is the recovery
      // point: route through the same reset path every other
      // census-stale trigger uses, gated the same way (only worth it when
      // the plan actually reads census output).
      if (censusStale && planIncludesComputedFallback()) scheduleCensusPublish();
    });
  };

  return {
    async start() {
      await publishBootstrap().catch((error: unknown) => {
        console.error('[Palette Mimicry] initial bootstrap failed', error);
      });
      if (isStopped()) return;

      await waitForDocumentReady(document);
      if (isStopped()) return;

      // Register before the authoritative settings read so a change that
      // lands during that read starts a newer generation instead of being
      // missed between the initial snapshot and listener installation.
      startSettingsListener();

      // Live analysis begins only after the DOM is ready. Small pages publish
      // a complete census after the settle window; larger pages keep their
      // partial walk private until the idle chunks converge.
      if (bootstrapCensus()) scheduleCensusPublish();
      censusObserver = observeCensusMutations();

      // A throwing initial apply() must not stop start() itself from
      // completing: the already-registered settings listener must remain able
      // to recover from a transient storage read error.
      await apply().catch((error: unknown) => {
        console.error('[Palette Mimicry] initial apply failed', error);
      });
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
      // Set before start() crosses either asynchronous startup boundary.
      stopped = true;
      stopSettingsListener?.();
      stopSettingsListener = null;
      stopDomObserver();
      stopCensusObserver();
      clearCensus();
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
