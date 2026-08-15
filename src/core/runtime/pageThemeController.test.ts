// @vitest-environment happy-dom
// src/core/runtime/pageThemeController.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { observeDomChanges } from '../live/observeDomChanges';
import { STORAGE_KEY } from '../storage/settingsStore';
import type { createStorageArea } from '../testing/storageArea';
import { createPageThemeController } from './pageThemeController';

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
// chains (getEffectiveSiteSettings -> getSettings -> storage.local.get, then
// writePlanDiagnostics -> storage.session.set). Ten ticks is a generous
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
  });
});
