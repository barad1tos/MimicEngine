import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { browser } from 'wxt/browser';
import type { createStorageArea } from '../testing/storageArea';
import {
  planStorageKey,
  readPlanDiagnostics,
  routePlanDiagnostics,
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
      runtime: {
        sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
      },
      storage: {
        session: createStorageArea(),
      },
    },
  };
});

const fakeBrowser = browser as unknown as {
  runtime: { sendMessage: Mock<(message: unknown) => Promise<unknown>> };
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
      unreadableStylesheetCount: 0,
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
  fakeBrowser.runtime.sendMessage.mockReset();
  fakeBrowser.storage.session.data.clear();
  fakeBrowser.storage.session.get.mockReset();
  fakeBrowser.storage.session.set.mockReset();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fakeBrowser.runtime.sendMessage.mockImplementation(
    (message: unknown) =>
      new Promise((resolve) => {
        const isHandled = routePlanDiagnostics(message, resolve);
        if (!isHandled) resolve(undefined);
      }),
  );
});

describe('writePlanDiagnostics', () => {
  it('stores the diagnostics object under planStorageKey(siteKey) in browser.storage.session', async () => {
    const diagnostics = buildDiagnostics('example.com');

    await writePlanDiagnostics(diagnostics);

    expect(fakeBrowser.storage.session.data.get(planStorageKey('example.com'))).toEqual(
      diagnostics,
    );
    expect(fakeBrowser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'write', diagnostics }),
    );
  });

  it('retries once after a 1s delay when the first background request fails', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = buildDiagnostics('example.com');
    fakeBrowser.runtime.sendMessage.mockRejectedValueOnce(new Error('background unavailable'));

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
    fakeBrowser.runtime.sendMessage.mockRejectedValue(new Error('background unavailable'));

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

  it('ignores malformed or unrelated background messages', () => {
    const respond = vi.fn();

    expect(routePlanDiagnostics({ operation: 'write' }, respond)).toBe(false);
    expect(routePlanDiagnostics({ channel: 'other', operation: 'write' }, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(fakeBrowser.storage.session.set).not.toHaveBeenCalled();
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
