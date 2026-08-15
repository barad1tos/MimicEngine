import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import type { createStorageArea } from '../testing/storageArea';
import {
  planStorageKey,
  readPlanDiagnostics,
  writePlanDiagnostics,
  type PlanDiagnostics,
} from './diagnostics';

// `createStorageArea` is imported dynamically inside the factory (rather
// than referenced from a static top-level import) because vi.mock factories
// are hoisted above the file's own import statements — a static reference
// here would throw a TDZ error at module-eval time.
vi.mock('wxt/browser', async () => {
  const { createStorageArea } = await import('../testing/storageArea');
  return {
    browser: {
      storage: {
        session: createStorageArea(),
      },
    },
  };
});

const fakeBrowser = browser as unknown as {
  storage: { session: ReturnType<typeof createStorageArea> };
};

function buildDiagnostics(siteKey: string): PlanDiagnostics {
  return {
    siteKey,
    plan: {
      provenance: {
        kind: 'auto',
        rule: 'variables-capable',
        strategies: ['baseline'],
        reasons: [],
        tableVersion: 1,
      },
    },
    metrics: {
      colorCustomPropertyCount: 0,
      domElementCount: 10,
      shadowRootCount: 0,
      unreadableStylesheetRatio: 0,
      authoredColorCount: 0,
      inlineStyleColorCount: 0,
      customPropertyColorRatio: 0,
      mutationRate: 0,
    },
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

afterEach(() => {
  fakeBrowser.storage.session.data.clear();
  fakeBrowser.storage.session.get.mockReset();
  fakeBrowser.storage.session.set.mockReset();
  vi.restoreAllMocks();
});

describe('writePlanDiagnostics', () => {
  it('stores the diagnostics object under planStorageKey(siteKey) in browser.storage.session', async () => {
    const diagnostics = buildDiagnostics('example.com');

    await writePlanDiagnostics(diagnostics);

    expect(fakeBrowser.storage.session.data.get(planStorageKey('example.com'))).toEqual(
      diagnostics,
    );
  });

  // Covers the background service worker's cold-start race: the content
  // script's first `apply()` can run before `storage.session.setAccessLevel`
  // executes, so the very first write throws once and then succeeds.
  it('retries once after a 1s delay and stores the value without warning when the retry succeeds', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = buildDiagnostics('example.com');
    fakeBrowser.storage.session.set.mockImplementationOnce(() => {
      throw new Error('storage unavailable during worker cold start');
    });

    const writePromise = writePlanDiagnostics(diagnostics);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(writePromise).resolves.toBeUndefined();

    expect(fakeBrowser.storage.session.data.get(planStorageKey('example.com'))).toEqual(
      diagnostics,
    );
    expect(warnSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('swallows the error and warns once when both the write and the retry throw', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakeBrowser.storage.session.set.mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    const writePromise = writePlanDiagnostics(buildDiagnostics('example.com'));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(writePromise).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Palette Mimicry]'),
      expect.any(Error),
    );
    vi.useRealTimers();
  });
});

describe('readPlanDiagnostics', () => {
  it('returns the stored object when present', async () => {
    const diagnostics = buildDiagnostics('example.com');
    fakeBrowser.storage.session.data.set(planStorageKey('example.com'), diagnostics);

    await expect(readPlanDiagnostics('example.com')).resolves.toEqual(diagnostics);
  });

  it('returns null when nothing is stored for the site', async () => {
    await expect(readPlanDiagnostics('absent.example')).resolves.toBeNull();
  });

  it('returns null for a malformed stored value instead of surfacing it', async () => {
    fakeBrowser.storage.session.data.set(planStorageKey('malformed.example'), {
      siteKey: 'malformed.example',
      plan: { provenance: { kind: 'bogus' } },
    });

    await expect(readPlanDiagnostics('malformed.example')).resolves.toBeNull();
  });

  it('swallows a thrown storage error, warns, and returns null instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakeBrowser.storage.session.get.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    await expect(readPlanDiagnostics('example.com')).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Palette Mimicry]'),
      expect.any(Error),
    );
  });
});
