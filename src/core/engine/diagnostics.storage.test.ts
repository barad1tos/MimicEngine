import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  planStorageKey,
  readPlanDiagnostics,
  writePlanDiagnostics,
  type PlanDiagnostics,
} from './diagnostics';

const { fakeBrowser } = vi.hoisted(() => {
  function createStorageArea() {
    const data = new Map<string, unknown>();
    return {
      data,
      get: vi.fn((key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
      set: vi.fn((items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      }),
    };
  }

  return {
    fakeBrowser: {
      storage: {
        session: createStorageArea(),
      },
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: fakeBrowser }));

function buildDiagnostics(siteKey: string): PlanDiagnostics {
  return {
    siteKey,
    plan: {
      strategies: ['baseline'],
      provenance: {
        kind: 'auto',
        rule: 'variables-capable',
        reasons: [],
        tableVersion: 1,
      },
    },
    metrics: {
      colorCustomPropertyCount: 0,
      domElementCount: 10,
      shadowRootCount: 0,
      unreadableStylesheetRatio: 0,
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

  it('swallows a thrown storage error and warns instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakeBrowser.storage.session.set.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    await expect(writePlanDiagnostics(buildDiagnostics('example.com'))).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Palette Mimicry]'),
      expect.any(Error),
    );
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
