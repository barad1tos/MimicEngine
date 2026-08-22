import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createDefaultSiteSettings, type SiteSettings } from './settingsStore';
import { ayuMirage } from '../themes/built-in/ayu';
import type { createStorageArea } from '../testing/storageArea';
import {
  readCachedStylesheet,
  STYLE_CACHE_KEY,
  writeCachedStylesheet,
  type StyleCacheContext,
} from './stylesheetCache';

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

const VALID_CSS = ':root {\n  --pm-canvas: #1f2430;\n}\n.card { color: #cbccc6; }';

function context(
  pathname = '/in/roman',
  settings: SiteSettings = createDefaultSiteSettings(ayuMirage.id),
): StyleCacheContext {
  return {
    siteKey: 'linkedin.com',
    pathname,
    theme: ayuMirage,
    settings,
  };
}

afterEach(() => {
  fakeBrowser.storage.session.data.clear();
  fakeBrowser.storage.session.get.mockReset();
  fakeBrowser.storage.session.set.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stylesheetCache', () => {
  it('round-trips a valid stylesheet for the same context', async () => {
    await writeCachedStylesheet(context(), VALID_CSS);

    await expect(readCachedStylesheet(context())).resolves.toBe(VALID_CSS);
    expect(fakeBrowser.storage.session.get).toHaveBeenCalledWith(STYLE_CACHE_KEY);
  });

  it.each([
    ['pathname', context('/feed')],
    ['site', { ...context(), siteKey: 'example.com' }],
    [
      'theme token',
      { ...context(), theme: { ...ayuMirage, tokens: { ...ayuMirage.tokens, canvas: '#000000' } } },
    ],
    [
      'strategy',
      context('/in/roman', { ...createDefaultSiteSettings(ayuMirage.id), strategy: 'baseline' }),
    ],
    [
      'preserveImages',
      context('/in/roman', {
        ...createDefaultSiteSettings(ayuMirage.id),
        preserveImages: false,
      }),
    ],
    [
      'preserveBrandColors',
      context('/in/roman', {
        ...createDefaultSiteSettings(ayuMirage.id),
        preserveBrandColors: false,
      }),
    ],
    [
      'override',
      context('/in/roman', {
        ...createDefaultSiteSettings(ayuMirage.id),
        overrides: [{ selector: '.card', property: 'color', token: 'accent' }],
      }),
    ],
  ])('misses when %s changes', async (_change, changedContext) => {
    await writeCachedStylesheet(context(), VALID_CSS);

    await expect(readCachedStylesheet(changedContext)).resolves.toBeNull();
  });

  it('canonicalizes override ordering before fingerprinting', async () => {
    const first = context('/in/roman', {
      ...createDefaultSiteSettings(ayuMirage.id),
      overrides: [
        { selector: '.zebra', property: 'color', token: 'text' },
        { selector: '.alpha', property: 'background-color', token: 'surface1' },
      ],
    });
    const reordered = context('/in/roman', {
      ...first.settings,
      overrides: [...first.settings.overrides].reverse(),
    });

    await writeCachedStylesheet(first, VALID_CSS);

    await expect(readCachedStylesheet(reordered)).resolves.toBe(VALID_CSS);
  });

  it.each(['/in/roman?view=all', '/in/roman#activity'])(
    'rejects a pathname containing query or fragment data: %s',
    async (pathname) => {
      await writeCachedStylesheet(context(pathname), VALID_CSS);

      expect(fakeBrowser.storage.session.set).not.toHaveBeenCalled();
      await expect(readCachedStylesheet(context(pathname))).resolves.toBeNull();
    },
  );

  it('expires entries after thirty minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T10:00:00Z'));
    await writeCachedStylesheet(context(), VALID_CSS);

    vi.setSystemTime(new Date('2026-08-22T10:30:00.001Z'));

    await expect(readCachedStylesheet(context())).resolves.toBeNull();
  });

  it('keeps at most 32 entries and evicts the oldest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T10:00:00Z'));

    for (let index = 0; index < 33; index += 1) {
      await writeCachedStylesheet(context(`/route-${String(index)}`), VALID_CSS);
      vi.advanceTimersByTime(1);
    }

    await expect(readCachedStylesheet(context('/route-0'))).resolves.toBeNull();
    await expect(readCachedStylesheet(context('/route-32'))).resolves.toBe(VALID_CSS);

    const stored = fakeBrowser.storage.session.data.get(STYLE_CACHE_KEY) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(stored.entries)).toHaveLength(32);
  });

  it.each([
    { css: '', caseName: 'empty' },
    { css: 'body { color: red; }', caseName: 'missing token preamble' },
    { css: ':root { color: red; }', caseName: 'missing canvas token' },
    { css: `:root { --pm-canvas: #000; } @import "theme.css";`, caseName: '@import' },
    {
      css: ':root { --pm-canvas: #000; } .x { background: url(image.png); }',
      caseName: 'url',
    },
    { css: ':root { --pm-canvas: #000; } </style>', caseName: 'closing style tag' },
    { css: ':root { --pm-canvas: #000; }' + 'x'.repeat(65_537), caseName: 'oversize' },
  ])('rejects unsafe or malformed css: $caseName', async ({ css }) => {
    await writeCachedStylesheet(context(), css);

    expect(fakeBrowser.storage.session.set).not.toHaveBeenCalled();
  });

  it('degrades storage failures to a miss or no-op', async () => {
    fakeBrowser.storage.session.get.mockRejectedValueOnce(new Error('read failed'));
    await expect(readCachedStylesheet(context())).resolves.toBeNull();

    fakeBrowser.storage.session.get.mockRejectedValueOnce(new Error('read failed'));
    await expect(writeCachedStylesheet(context(), VALID_CSS)).resolves.toBeUndefined();
    expect(fakeBrowser.storage.session.set).not.toHaveBeenCalled();

    fakeBrowser.storage.session.set.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    await expect(writeCachedStylesheet(context(), VALID_CSS)).resolves.toBeUndefined();
  });

  it('degrades digest failures to a miss or no-op', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('digest failed'));

    await expect(readCachedStylesheet(context())).resolves.toBeNull();
    await expect(writeCachedStylesheet(context(), VALID_CSS)).resolves.toBeUndefined();
    expect(fakeBrowser.storage.session.get).not.toHaveBeenCalled();
  });

  it('uses opaque digest keys instead of raw route or settings data', async () => {
    await writeCachedStylesheet(context(), VALID_CSS);

    const stored = fakeBrowser.storage.session.data.get(STYLE_CACHE_KEY) as {
      entries: Record<string, unknown>;
    };
    const keys = Object.keys(stored.entries);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys[0]).not.toContain('/in/roman');
    expect(keys[0]).not.toContain(ayuMirage.tokens.canvas);
  });

  it.each([
    { schemaVersion: 2, engineRevision: 1, entries: {} },
    { schemaVersion: 1, engineRevision: 2, entries: {} },
  ])('misses an incompatible cache store', async (stored) => {
    fakeBrowser.storage.session.data.set(STYLE_CACHE_KEY, stored);

    await expect(readCachedStylesheet(context())).resolves.toBeNull();
  });
});
