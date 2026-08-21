// @vitest-environment happy-dom
// src/core/runtime/pageThemeController.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { installedCensus } from '../analyzer/signatureCensus';
import { planStorageKey, type PlanDiagnostics } from '../engine/diagnostics';
import * as shadowStylesModule from '../injector/shadowStyles';
import * as styleElementModule from '../injector/styleElement';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';
import { observeDomChanges } from '../live/observeDomChanges';
import { IMPORTED_THEMES_KEY, type ImportedTheme } from '../storage/importedThemesStore';
import { createDefaultSiteSettings, STORAGE_KEY, type AppSettings } from '../storage/settingsStore';
import { normalizeHostname } from '../storage/siteKey';
import type { createStorageArea } from '../testing/storageArea';
import { THEME_TOKEN_NAMES, type ThemeTokens } from '../themes';
import { createPageThemeController } from './pageThemeController';

// All 14 theme tokens set to the same hex, for tests that only care whether
// a particular color made it into the injected stylesheet, not the full
// palette.
function buildUniformTokens(hex: string): ThemeTokens {
  return Object.fromEntries(THEME_TOKEN_NAMES.map((tokenName) => [tokenName, hex])) as ThemeTokens;
}

type ChangeListener = (changes: Record<string, unknown>, areaName: string) => void;

const MAX_REAPPLIES_PER_MINUTE = 12;

// happy-dom's layout engine always reports zero-size rects, which makes the
// census' visibility filter (isProbablyVisible) reject every element by
// default — fine for tests that only assert traversal completion/counts,
// but a test asserting on *sampled* content (e.g. whether an addition taught
// the census something new) needs elements to read as laid-out, same as
// signatureCensus.test.ts's own fixture stub.
const VISIBLE_RECT = {
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  left: 0,
  right: 100,
  bottom: 20,
  toJSON: () => ({}),
} as DOMRect;

// The real observer (MutationObserver + 250ms debounce, wired up in
// `observeDomChanges`) is exercised by the T12 real-browser smoke, not here.
// This seam swap replaces it with a captured callback the test can invoke
// directly and repeatedly — the only way to deterministically reproduce the
// cap-revival race, which requires a *specific* apply() call to still be in
// flight when a later firing trips the cap. Real MutationObserver timing
// combined with fake timers and this many interleaved async apply() calls
// proved too unreliable to drive that precise interleaving deterministically.
const { capturedObserverCallbacks, observerStopSpy } = vi.hoisted(() => ({
  capturedObserverCallbacks: [] as (() => void)[],
  observerStopSpy: vi.fn(),
}));

vi.mock('../live/observeDomChanges', () => ({
  observeDomChanges: vi.fn((callback: () => void) => {
    capturedObserverCallbacks.push(callback);
    return { stop: observerStopSpy };
  }),
}));

// `createStorageArea` is imported dynamically inside the factory (rather
// than referenced from a static top-level import) because vi.mock factories
// are hoisted above the file's own import statements — a static reference
// here would throw a TDZ error at module-eval time.
vi.mock('wxt/browser', async () => {
  const { createStorageArea } = await import('../testing/storageArea');
  const listeners = new Set<ChangeListener>();

  return {
    browser: {
      storage: {
        local: createStorageArea(),
        session: createStorageArea(),
        onChanged: {
          addListener: (listener: ChangeListener) => listeners.add(listener),
          removeListener: (listener: ChangeListener) => listeners.delete(listener),
        },
        emitChange(changes: Record<string, unknown>, areaName: string) {
          for (const listener of listeners) listener(changes, areaName);
        },
      },
    },
  };
});

const fakeBrowser = browser as unknown as {
  storage: {
    local: ReturnType<typeof createStorageArea>;
    session: ReturnType<typeof createStorageArea>;
    emitChange: (changes: Record<string, unknown>, areaName: string) => void;
  };
};

function fireLatestObserverCallback(): void {
  const callback = capturedObserverCallbacks.at(-1);
  if (!callback) throw new Error('no observer callback captured yet — did start() run?');
  callback();
}

// Bounded microtask drain for the controller's short, statically-known await
// chains (readApplyInputs -> storage.local.get, then writePlanDiagnostics ->
// storage.session.set). Ten ticks is a generous
// multiple of the ~4 awaits actually involved, with no real timers or I/O in
// play, so this stays deterministic rather than timing-dependent.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// Shared by every describe block below that reads back the diagnostics the
// controller wrote for a given site under `planStorageKey`.
function lastWrittenDiagnostics(siteKey: string): PlanDiagnostics {
  const key = planStorageKey(siteKey);
  const diagnostics = fakeBrowser.storage.session.data.get(key) as PlanDiagnostics | undefined;
  if (!diagnostics) throw new Error('expected diagnostics to have been written');
  return diagnostics;
}

// Shared by every describe block below that needs an open shadow root to
// assert shadow-stylesheet lifecycle behavior against.
function attachOpenShadowHost(): ShadowRoot {
  const host = document.createElement('div');
  document.body.append(host);
  return host.attachShadow({ mode: 'open' });
}

// Builds `elementCount` <span> elements with a rotating 4-class list, used by
// the census lifecycle describe block below to exercise a page large enough
// to span the sync CENSUS_FIRST_CHUNK plus one or more idle CENSUS_IDLE_CHUNK
// passes, with more than one distinct signature in play.
function bigFixture(elementCount: number): string {
  const classNames = ['a', 'b', 'c', 'd'];
  return Array.from({ length: elementCount }, (_, index) => {
    const className = classNames[index % classNames.length] ?? 'a';
    return `<span class="rotating-${className}">x</span>`;
  }).join('');
}

beforeEach(() => {
  capturedObserverCallbacks.length = 0;
  observerStopSpy.mockClear();
});

afterEach(() => {
  fakeBrowser.storage.local.data.clear();
  fakeBrowser.storage.session.data.clear();
  fakeBrowser.storage.local.get.mockReset();
  fakeBrowser.storage.local.set.mockClear();
  fakeBrowser.storage.session.set.mockClear();
  vi.restoreAllMocks();
});

describe('createPageThemeController — mutation cap gating', () => {
  it('gates observer re-creation on capTripped, closing the pre-cap apply() race, and only a settings change revives it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = createPageThemeController();

    await controller.start();
    expect(vi.mocked(observeDomChanges)).toHaveBeenCalledTimes(1);

    // Stall the very next settings read so the mutation-triggered apply() it
    // belongs to (firing #1 below) is still in flight — pre-cap — when a
    // later firing trips the cap.
    const stalledSettings = Promise.withResolvers<Record<string, unknown>>();
    fakeBrowser.storage.local.get.mockImplementationOnce(() => stalledSettings.promise);

    // Firing #1: counts, then calls apply() — which now hangs on the
    // stalled settings read instead of resolving.
    fireLatestObserverCallback();

    // Firings #2 through #12: still under the cap; each apply() resolves
    // normally against the default (non-stalled) mock.
    for (let firing = 2; firing <= MAX_REAPPLIES_PER_MINUTE; firing++) {
      fireLatestObserverCallback();
    }
    await flushMicrotasks();

    // Firing #13 trips the cap synchronously: stops the observer and warns
    // once, without ever calling apply() for this firing.
    fireLatestObserverCallback();

    expect(observerStopSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('re-apply cap reached'));

    // The stalled apply() from firing #1 now resolves — after the cap has
    // already tripped. Without the capTripped gate, this reaches
    // ensureDomObserver(), finds domObserver === null, and re-creates it.
    stalledSettings.resolve({});
    await flushMicrotasks();

    expect(vi.mocked(observeDomChanges)).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Only a settings change clears capTripped and revives observation.
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(vi.mocked(observeDomChanges)).toHaveBeenCalledTimes(2);

    // The mocked browser.storage.onChanged listener set is module-level and
    // outlives this test; an un-stopped controller's listener would keep
    // firing (and consuming other tests' mockImplementationOnce queues) for
    // every later test's emitChange call.
    controller.stop();
  });
});

describe('createPageThemeController — apply() generation guard', () => {
  it('a stalled older apply resolving after a newer one must not overwrite the newer stylesheet or diagnostics', async () => {
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();

    await controller.start();
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.storage.session.set).toHaveBeenCalledTimes(1);

    // Stall the settings read the next settings-changed apply() will make —
    // this becomes generation 2, and it never gets past this await.
    const stalledSettings = Promise.withResolvers<Record<string, unknown>>();
    fakeBrowser.storage.local.get.mockImplementationOnce(() => stalledSettings.promise);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();
    // Generation 2 is stuck awaiting settings — nothing new injected or written yet.
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.storage.session.set).toHaveBeenCalledTimes(1);

    // Generation 3: a second settings change, resolving normally, becomes
    // "the newest" — it injects and writes diagnostics while generation 2 is
    // still stalled.
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();
    expect(injectSpy).toHaveBeenCalledTimes(2);
    expect(fakeBrowser.storage.session.set).toHaveBeenCalledTimes(2);

    // Generation 2's stalled settings read finally resolves — it must abort
    // instead of re-injecting/re-writing over generation 3's results.
    stalledSettings.resolve({});
    await flushMicrotasks();

    expect(injectSpy).toHaveBeenCalledTimes(2);
    expect(fakeBrowser.storage.session.set).toHaveBeenCalledTimes(2);

    controller.stop();
  });
});

describe('createPageThemeController — stop() invalidates in-flight apply()', () => {
  it('an apply() stalled on the settings read at stop() time must not reactivate styling once it resolves', async () => {
    const siteKey = normalizeHostname(window.location.hostname);
    // A settings shape that, if this apply() were allowed to proceed, would
    // inject the document stylesheet, set data-pm-active, AND sync shadow
    // stylesheets — so a passing test actually proves stop()'s guard is
    // doing the work, not merely that there was nothing to do.
    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), strategy: 'deepRemap' } },
    };
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const syncSpy = vi.spyOn(shadowStylesModule, 'syncShadowStylesheets');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Clean baseline: earlier tests in this file may have left the main
    // style element and data-pm-active behind (stop() doesn't remove the
    // document-level stylesheet), so start from a known-empty state.
    document.getElementById(styleElementModule.STYLE_ELEMENT_ID)?.remove();
    delete document.documentElement.dataset.pmActive;

    const stalledSettings = Promise.withResolvers<Record<string, unknown>>();
    fakeBrowser.storage.local.get.mockImplementationOnce(() => stalledSettings.promise);

    const controller = createPageThemeController();
    // start() calls apply(), which suspends synchronously at the settings
    // read above — by the time this line returns, apply() is stalled.
    const startPromise = controller.start();

    controller.stop();

    // The stalled apply() finally resolves, after stop() already ran.
    stalledSettings.resolve({ [STORAGE_KEY]: settings });
    await startPromise;
    await flushMicrotasks();

    expect(injectSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(document.getElementById(styleElementModule.STYLE_ELEMENT_ID)).toBeNull();
    expect(document.documentElement.dataset.pmActive).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    // LISTENER-AFTER-STOP: start() only registers its settings-changed
    // listener after its initial apply() settles — stop() ran while that
    // apply() was still stalled, so start() must skip registration entirely
    // once the stall resolves, rather than registering a listener on an
    // already-stopped controller. A settings change here must therefore
    // trigger nothing; this replaces the previous workaround of calling
    // controller.stop() a second time just to silence the leaked listener
    // for later tests.
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(injectSpy).not.toHaveBeenCalled();
    expect(fakeBrowser.storage.session.set).not.toHaveBeenCalled();
  });
});

describe('createPageThemeController — coverage gating', () => {
  // Matches exactly what the controller itself computes internally, so this
  // stays correct regardless of what happy-dom's default test hostname is.
  const siteKey = normalizeHostname(window.location.hostname);

  function seedSiteSettings(strategy: AppSettings['sites'][string]['strategy']): void {
    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), strategy } },
    };
    fakeBrowser.storage.local.data.set(STORAGE_KEY, settings);
  }

  it('writes a coverage report when the plan includes authoredRemap', async () => {
    seedSiteSettings('authoredRemap');
    const controller = createPageThemeController();

    await controller.start();

    expect(lastWrittenDiagnostics(siteKey).coverage).toBeDefined();

    controller.stop();
  });

  it('omits the coverage field entirely when the plan does not include authoredRemap', async () => {
    seedSiteSettings('baseline');
    const controller = createPageThemeController();

    await controller.start();

    const diagnostics = lastWrittenDiagnostics(siteKey);
    expect(diagnostics.coverage).toBeUndefined();
    expect(Object.hasOwn(diagnostics, 'coverage')).toBe(false);

    controller.stop();
  });
});

describe('createPageThemeController — initial apply failure', () => {
  it('start() with a throwing first apply still registers the settings-changed listener', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakeBrowser.storage.local.get.mockImplementationOnce(() =>
      Promise.reject(new Error('storage read failed')),
    );
    const controller = createPageThemeController();

    await expect(controller.start()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[Palette Mimicry] initial apply failed',
      expect.any(Error),
    );
    // The settings-changed listener registers via browser.storage.onChanged
    // — the same listener capturedObserverCallbacks/emitChange rely on
    // elsewhere in this file, so a settings change now must still trigger
    // a fresh apply() rather than the controller being left unwired.
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(fakeBrowser.storage.session.set).toHaveBeenCalledTimes(1);

    controller.stop();
  });
});

describe('createPageThemeController — batched storage read', () => {
  it('reads settings and imported themes in exactly one storage.get call carrying both keys', async () => {
    const controller = createPageThemeController();

    await controller.start();

    expect(fakeBrowser.storage.local.get).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.storage.local.get).toHaveBeenCalledWith([STORAGE_KEY, IMPORTED_THEMES_KEY]);

    controller.stop();
  });

  it('keeps issuing exactly one storage.get call, with both keys, on every subsequent apply', async () => {
    const controller = createPageThemeController();
    await controller.start();
    fakeBrowser.storage.local.get.mockClear();

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(fakeBrowser.storage.local.get).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.storage.local.get).toHaveBeenCalledWith([STORAGE_KEY, IMPORTED_THEMES_KEY]);

    controller.stop();
  });

  it('re-applies when the imported-themes store changes', async () => {
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();
    await controller.start();
    expect(injectSpy).toHaveBeenCalledTimes(1);

    fakeBrowser.storage.emitChange({ [IMPORTED_THEMES_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(injectSpy).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('falls back to the default theme, without crashing, when the referenced imported theme is deleted mid-session', async () => {
    const siteKey = normalizeHostname(window.location.hostname);
    const importedTheme: ImportedTheme = {
      id: 'imported:vanished',
      name: 'Vanished',
      mode: 'dark',
      sourceFormat: 'vscode',
      tokens: buildUniformTokens('#123456'),
    };
    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), themeId: importedTheme.id } },
    };
    fakeBrowser.storage.local.data.set(STORAGE_KEY, settings);
    fakeBrowser.storage.local.data.set(IMPORTED_THEMES_KEY, {
      schemaVersion: 1,
      themes: [importedTheme],
      recentSources: [],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = createPageThemeController();
    await controller.start();

    expect(document.getElementById(styleElementModule.STYLE_ELEMENT_ID)?.textContent).toContain(
      '#123456',
    );

    // Delete the referenced imported theme mid-session and let the widened
    // onSettingsChanged listener pick it up.
    fakeBrowser.storage.local.data.set(IMPORTED_THEMES_KEY, {
      schemaVersion: 1,
      themes: [],
      recentSources: [],
    });
    fakeBrowser.storage.emitChange({ [IMPORTED_THEMES_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(errorSpy).not.toHaveBeenCalled();
    const styleText = document.getElementById(styleElementModule.STYLE_ELEMENT_ID)?.textContent;
    expect(styleText).toContain('#303446'); // catppuccinFrappe canvas token
    expect(styleText).not.toContain('#123456');

    controller.stop();
  });
});

describe('createPageThemeController — shadow stylesheet lifecycle', () => {
  const siteKey = normalizeHostname(window.location.hostname);

  function seedSiteSettings(overrides: Partial<AppSettings['sites'][string]> = {}): void {
    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), strategy: 'deepRemap', ...overrides } },
    };
    fakeBrowser.storage.local.data.set(STORAGE_KEY, settings);
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('writes our style element into an open shadow root for a manual deepRemap plan', async () => {
    const shadowRoot = attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();

    await controller.start();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeInstanceOf(HTMLStyleElement);

    controller.stop();
  });

  it('removes the shadow style element once a later apply switches strategy away from deepRemap', async () => {
    const shadowRoot = attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();
    await controller.start();
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).not.toBeNull();

    seedSiteSettings({ strategy: 'baseline' });
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();

    controller.stop();
  });

  it('removes the shadow style element once the site is disabled', async () => {
    const shadowRoot = attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();
    await controller.start();
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).not.toBeNull();

    seedSiteSettings({ enabled: false });
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();

    controller.stop();
  });

  it('keeps the shadow style element on stop() while deepRemap is active', async () => {
    const shadowRoot = attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();
    await controller.start();
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).not.toBeNull();

    controller.stop();

    // BFCACHE SYMMETRY RULING: stop() no longer removes shadow styles.
    // stop() already left the document stylesheet and the data-pm-active
    // gate in place — a bfcache-restored page shows a fully themed static
    // page — so removing only the shadow styles here used to leave a
    // themed-document/unthemed-shadow asymmetry instead. The orphan
    // self-heal in apply() (pageThemeController.ts) is the safety net that
    // cleans up any shadow styles a now-dead controller instance leaves
    // behind, the next time a controller starts on this page.
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).not.toBeNull();
  });

  it('identity-skips the shadow stylesheet write when a later apply produces the same theme', async () => {
    attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();
    await controller.start();

    const textContentSetter = vi.spyOn(Node.prototype, 'textContent', 'set');
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    expect(textContentSetter).not.toHaveBeenCalled();
    textContentSetter.mockRestore();

    controller.stop();
  });

  it('a stalled older apply resolving after a newer one must not sync shadow stylesheets on top of it', async () => {
    attachOpenShadowHost();
    seedSiteSettings();
    const syncSpy = vi.spyOn(shadowStylesModule, 'syncShadowStylesheets');
    const controller = createPageThemeController();

    await controller.start();
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Stall the settings read the next settings-changed apply() will make —
    // this becomes generation 2, and it never gets past this await.
    const stalledSettings = Promise.withResolvers<Record<string, unknown>>();
    fakeBrowser.storage.local.get.mockImplementationOnce(() => stalledSettings.promise);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();
    // Generation 2 is stuck awaiting settings — no new shadow sync yet.
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Generation 3: a second settings change, resolving normally, becomes
    // "the newest" — it syncs shadow stylesheets while generation 2 is still
    // stalled.
    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();
    expect(syncSpy).toHaveBeenCalledTimes(2);

    // Generation 2's stalled settings read finally resolves — it must abort
    // instead of syncing shadow stylesheets over generation 3's results.
    stalledSettings.resolve({});
    await flushMicrotasks();

    expect(syncSpy).toHaveBeenCalledTimes(2);

    controller.stop();
  });
});

describe('createPageThemeController — orphan shadow self-heal', () => {
  const siteKey = normalizeHostname(window.location.hostname);

  function seedBaselineSettings(): void {
    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), strategy: 'baseline' } },
    };
    fakeBrowser.storage.local.data.set(STORAGE_KEY, settings);
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sweeps an orphaned shadow style element left by a dead controller instance on the first apply of a non-deepRemap plan, then stops walking on later applies', async () => {
    const shadowRoot = attachOpenShadowHost();
    // Simulate a style element a previous (now-dead) controller instance
    // left behind in this shadow root: this fresh controller never synced
    // it itself, so shadowStylesActive starts false and the cheap guarded
    // removal path (deactivateShadowStyles) would otherwise never catch it.
    const orphanStyle = document.createElement('style');
    orphanStyle.id = STYLE_ELEMENT_ID;
    shadowRoot.append(orphanStyle);

    seedBaselineSettings();
    const removeSpy = vi.spyOn(shadowStylesModule, 'removeShadowStylesheets');
    const controller = createPageThemeController();

    await controller.start();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    // Second apply: firstApplyCompleted is now true, so it falls back to
    // the cheap shadowStylesActive-guarded path (false, since this
    // controller never synced shadow styles itself) instead of walking the
    // shadow tree again.
    expect(removeSpy).toHaveBeenCalledTimes(1);

    controller.stop();
  });

  it('sweeps an orphaned shadow style element on the first apply of a disabled site, then stops walking on later disabled applies', async () => {
    const shadowRoot = attachOpenShadowHost();
    // Same orphan scenario as the enabled/baseline test above, but this
    // controller's site is disabled from the start. The disabled early
    // return in apply() has its own shadow removal call
    // (deactivateShadowStyles(), guarded by shadowStylesActive, which is
    // always false for a fresh instance) — it must not skip the same
    // orphan the enabled/non-deepRemap path above already self-heals.
    const orphanStyle = document.createElement('style');
    orphanStyle.id = STYLE_ELEMENT_ID;
    shadowRoot.append(orphanStyle);

    const settings: AppSettings = {
      schemaVersion: 2,
      globalThemeId: 'catppuccin-frappe',
      sites: { [siteKey]: { ...createDefaultSiteSettings(), enabled: false } },
    };
    fakeBrowser.storage.local.data.set(STORAGE_KEY, settings);
    const removeSpy = vi.spyOn(shadowStylesModule, 'removeShadowStylesheets');
    const controller = createPageThemeController();

    await controller.start();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    await flushMicrotasks();

    // Second disabled apply: firstApplyCompleted is now true, so it falls
    // back to the cheap shadowStylesActive-guarded path instead of walking
    // the shadow tree again.
    expect(removeSpy).toHaveBeenCalledTimes(1);

    controller.stop();
  });
});

describe('createPageThemeController — census lifecycle', () => {
  const siteKey = normalizeHostname(window.location.hostname);

  beforeEach(() => {
    vi.useFakeTimers();
    // requestIdleCallback/cancelIdleCallback don't exist in happy-dom;
    // stubbed here (rather than at module scope) so the controller's
    // per-call globalThis lookup picks these up. The 0ms delay lets a
    // deadline callback fire on the very next fake-timer tick, same as a
    // real idle slot opening up almost immediately on a quiet page.
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) =>
      window.setTimeout(() => {
        callback({ didTimeout: false, timeRemaining: () => 50 });
      }, 0),
    );
    vi.stubGlobal('cancelIdleCallback', (handle: number) => {
      window.clearTimeout(handle);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('installs a census on start and clears it on stop', async () => {
    const controller = createPageThemeController();

    await controller.start();
    expect(installedCensus()).not.toBeNull();

    controller.stop();
    expect(installedCensus()).toBeNull();
  });

  it('writes the live census snapshot into the diagnostics record and keeps it current across re-applies', async () => {
    document.body.innerHTML = bigFixture(1200); // exceeds CENSUS_FIRST_CHUNK (800)
    const controller = createPageThemeController();

    await controller.start();
    const snapshotAfterInitialApply = installedCensus()?.snapshot();
    expect(lastWrittenDiagnostics(siteKey).census).toEqual({
      complete: snapshotAfterInitialApply?.complete,
      signatureCount: snapshotAfterInitialApply?.signatureCount,
      elementsVisited: snapshotAfterInitialApply?.elementsVisited,
      droppedProperties: snapshotAfterInitialApply?.droppedProperties,
    });
    expect(lastWrittenDiagnostics(siteKey).census?.complete).toBe(false);

    await vi.runAllTimersAsync(); // drains idle callbacks + the census debounce

    const finalSnapshot = installedCensus()?.snapshot();
    expect(finalSnapshot?.complete).toBe(true);
    expect(lastWrittenDiagnostics(siteKey).census).toEqual({
      complete: finalSnapshot?.complete,
      signatureCount: finalSnapshot?.signatureCount,
      elementsVisited: finalSnapshot?.elementsVisited,
      droppedProperties: finalSnapshot?.droppedProperties,
    });

    controller.stop();
  });

  it('continues the census through idle callbacks until it completes, then re-applies', async () => {
    document.body.innerHTML = bigFixture(1200); // exceeds CENSUS_FIRST_CHUNK (800)
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();

    await controller.start();
    // The synchronous first chunk (800) cannot have finished walking a
    // 1200+-element document yet.
    expect(installedCensus()?.snapshot().complete).toBe(false);
    const injectCountAfterInitialApply = injectSpy.mock.calls.length;

    await vi.runAllTimersAsync(); // drains idle callbacks + the census debounce

    expect(installedCensus()?.snapshot().complete).toBe(true);
    // The census-driven debounced re-apply must have fired at least once
    // beyond the initial apply from start().
    expect(injectSpy.mock.calls.length).toBeGreaterThan(injectCountAfterInitialApply);

    controller.stop();
  });

  it('census progress never trips the mutation cap or counts toward the mutation rate', async () => {
    document.body.innerHTML = bigFixture(5000); // several idle chunks
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = createPageThemeController();

    await controller.start();
    await vi.runAllTimersAsync();

    expect(installedCensus()?.snapshot().complete).toBe(true);
    // capTripped only ever surfaces through this warning — never fired means
    // the cap never tripped despite many census-driven re-applies.
    expect(warnSpy).not.toHaveBeenCalled();
    // mutationRate only advances via registerMutationCallback, which only
    // the page-mutation path (ensureDomObserver's callback) touches — a
    // census re-apply's own diagnostics write must still read it as 0.
    expect(lastWrittenDiagnostics(siteKey).metrics.mutationRate).toBe(0);

    controller.stop();
  });

  it('a stopped controller schedules no further census work', async () => {
    document.body.innerHTML = bigFixture(1200);
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();

    await controller.start();
    const injectCountAtStop = injectSpy.mock.calls.length;
    controller.stop();

    await vi.runAllTimersAsync(); // must not throw from an orphaned idle callback

    expect(installedCensus()).toBeNull();
    expect(injectSpy.mock.calls).toHaveLength(injectCountAtStop);
  });

  it('an intervening mutation-driven apply() does not strand the census walk', async () => {
    // Sync chunk (800) + two idle chunks (1000 each) reach the end of a
    // ~2500-element document. Regression for a bug where scheduleCensusChunk
    // captured applyGeneration — bumped by every apply(), including the
    // census's own debounced reapply — so an unrelated apply() firing
    // between two idle chunks made the next chunk's generation check fail
    // and the walk stranded forever (reproduced: stuck at ~801 elements,
    // complete permanently false).
    document.body.innerHTML = bigFixture(2500);
    const controller = createPageThemeController();

    await controller.start();
    expect(installedCensus()?.snapshot().complete).toBe(false);

    // A page mutation fires the (mocked) live observer's callback before the
    // first scheduled idle timeout runs — this apply() bumps applyGeneration
    // but must have no bearing on the census's own idle-chunk loop.
    fireLatestObserverCallback();

    await vi.runAllTimersAsync(); // drains every idle chunk + census debounce

    const snapshot = installedCensus()?.snapshot();
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.elementsVisited).toBeGreaterThanOrEqual(2500);

    controller.stop();
  });

  it('a real DOM mutation observed only by the census observer does not bypass a tripped mutation cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();

    await controller.start();
    // Trip the cap through the mocked live-observer path (matches the
    // "mutation cap gating" describe block's own firing pattern).
    for (let firing = 1; firing <= MAX_REAPPLIES_PER_MINUTE + 1; firing++) {
      fireLatestObserverCallback();
    }
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const injectCountAtCap = injectSpy.mock.calls.length;

    // observeDomChanges is entirely mocked in this file (no real
    // MutationObserver behind the mocked domObserver) — a genuine DOM
    // mutation is seen only by the controller's own real censusObserver.
    // Regression: that observer used to ingest and schedule a reapply
    // unconditionally, bypassing capTripped entirely.
    document.body.append(document.createElement('span'));
    await flushMicrotasks();
    await vi.runAllTimersAsync();

    expect(injectSpy.mock.calls).toHaveLength(injectCountAtCap);
    expect(warnSpy).toHaveBeenCalledTimes(1); // no additional cap warning

    controller.stop();
  });

  it('ingesting an addition that teaches the census nothing schedules no census reapply', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(VISIBLE_RECT);
    // Five identical elements exceed REPRESENTATIVES_PER_SIGNATURE (3)
    // during the initial synchronous traversal, so this signature is
    // already fully sampled — a later addition of the exact same signature
    // teaches ingestAddedElements nothing new.
    document.body.innerHTML = '<span class="steady">a</span>'.repeat(5);
    const injectSpy = vi.spyOn(styleElementModule, 'injectStylesheet');
    const controller = createPageThemeController();

    await controller.start();
    const injectCountAfterInitialApply = injectSpy.mock.calls.length;

    const addition = document.createElement('span');
    addition.className = 'steady';
    document.body.append(addition);
    await flushMicrotasks();
    await vi.runAllTimersAsync();

    expect(injectSpy.mock.calls).toHaveLength(injectCountAfterInitialApply);

    controller.stop();
  });
});
