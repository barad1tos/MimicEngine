import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_THEME_ID } from '../themes';
import type { createStorageArea } from '../testing/storageArea';
import {
  createDefaultSiteSettings,
  getEffectiveSiteSettings,
  getSettings,
  onSettingsChanged,
  saveSettings,
  STORAGE_KEY,
  type AppSettings,
} from './settingsStore';

type ChangeListener = (changes: Record<string, unknown>, areaName: string) => void;

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
        listenerCount() {
          return listeners.size;
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
    listenerCount: () => number;
  };
};

afterEach(() => {
  fakeBrowser.storage.local.data.clear();
  fakeBrowser.storage.local.get.mockClear();
  fakeBrowser.storage.local.set.mockClear();
});

describe('getSettings', () => {
  it('returns normalized defaults when raw storage is garbage', async () => {
    fakeBrowser.storage.local.data.set(STORAGE_KEY, 'nonsense');

    const settings = await getSettings();

    expect(settings).toEqual({ schemaVersion: 2, globalThemeId: DEFAULT_THEME_ID, sites: {} });
  });

  it('reads through browser.storage.local.get keyed by STORAGE_KEY', async () => {
    fakeBrowser.storage.local.data.set(STORAGE_KEY, {
      globalThemeId: 'placeholder-theme',
      sites: {},
    });

    await getSettings();

    expect(fakeBrowser.storage.local.get).toHaveBeenCalledWith(STORAGE_KEY);
  });
});

describe('saveSettings', () => {
  it('writes the normalized (v2) value under STORAGE_KEY, given a legacy-shaped input', async () => {
    const legacyShaped = {
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { enabled: true, themeId: 'placeholder-theme', mode: 'off' },
      },
    } as unknown as AppSettings;

    await saveSettings(legacyShaped);

    expect(fakeBrowser.storage.local.data.get(STORAGE_KEY)).toEqual({
      schemaVersion: 2,
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': {
          enabled: false,
          themeId: 'placeholder-theme',
          strategy: 'auto',
          preserveImages: true,
          preserveBrandColors: true,
          overrides: [],
        },
      },
    });
  });
});

describe('getEffectiveSiteSettings', () => {
  it('returns the stored site entry when present', async () => {
    fakeBrowser.storage.local.data.set(STORAGE_KEY, {
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': {
          enabled: true,
          themeId: 'placeholder-theme',
          strategy: 'variableRemap',
          preserveImages: false,
          overrides: [],
        },
      },
    });

    const site = await getEffectiveSiteSettings('example.com');

    expect(site).toEqual({
      enabled: true,
      themeId: 'placeholder-theme',
      strategy: 'variableRemap',
      preserveImages: false,
      preserveBrandColors: true,
      overrides: [],
    });
  });

  it('falls back to createDefaultSiteSettings(globalThemeId) when the site is absent', async () => {
    fakeBrowser.storage.local.data.set(STORAGE_KEY, {
      globalThemeId: 'placeholder-theme',
      sites: {},
    });

    const site = await getEffectiveSiteSettings('unknown.example');

    expect(site).toEqual(createDefaultSiteSettings('placeholder-theme'));
  });
});

describe('onSettingsChanged', () => {
  it('fires the callback only for area "local" changes to STORAGE_KEY', () => {
    const callback = vi.fn();
    const unsubscribe = onSettingsChanged(callback);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    expect(callback).toHaveBeenCalledTimes(1);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'sync');
    expect(callback).toHaveBeenCalledTimes(1);

    fakeBrowser.storage.emitChange({ 'unrelated-key': { newValue: {} } }, 'local');
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('removes the listener when the returned unsubscribe is called', () => {
    const callback = vi.fn();
    const countBefore = fakeBrowser.storage.listenerCount();
    const unsubscribe = onSettingsChanged(callback);

    expect(fakeBrowser.storage.listenerCount()).toBe(countBefore + 1);

    unsubscribe();

    expect(fakeBrowser.storage.listenerCount()).toBe(countBefore);

    fakeBrowser.storage.emitChange({ [STORAGE_KEY]: { newValue: {} } }, 'local');
    expect(callback).not.toHaveBeenCalled();
  });
});
