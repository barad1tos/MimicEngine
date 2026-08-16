// @vitest-environment happy-dom
// src/core/runtime/pageThemeController.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
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

    // start() only registers its settings-changed listener after its initial
    // apply() settles (even an aborted one) — since that registration ran
    // after the stop() above, it must be torn down again here, or it would
    // keep firing apply() for every later test's emitChange call.
    controller.stop();
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

  function lastWrittenDiagnostics(): PlanDiagnostics {
    const key = planStorageKey(siteKey);
    const diagnostics = fakeBrowser.storage.session.data.get(key) as PlanDiagnostics | undefined;
    if (!diagnostics) throw new Error('expected diagnostics to have been written');
    return diagnostics;
  }

  it('writes a coverage report when the plan includes authoredRemap', async () => {
    seedSiteSettings('authoredRemap');
    const controller = createPageThemeController();

    await controller.start();

    expect(lastWrittenDiagnostics().coverage).toBeDefined();

    controller.stop();
  });

  it('omits the coverage field entirely when the plan does not include authoredRemap', async () => {
    seedSiteSettings('baseline');
    const controller = createPageThemeController();

    await controller.start();

    const diagnostics = lastWrittenDiagnostics();
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

  function attachOpenShadowHost(): ShadowRoot {
    const host = document.createElement('div');
    document.body.append(host);
    return host.attachShadow({ mode: 'open' });
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

  it('removes the shadow style element on stop() while deepRemap is active', async () => {
    const shadowRoot = attachOpenShadowHost();
    seedSiteSettings();
    const controller = createPageThemeController();
    await controller.start();
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).not.toBeNull();

    controller.stop();

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
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
