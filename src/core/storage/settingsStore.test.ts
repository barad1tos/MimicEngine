import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_ID } from '../themes';
import {
  DEFAULT_SETTINGS,
  createDefaultSiteSettings,
  normalizeSettings,
  pruneThemeReferences,
} from './settingsStore';

describe('normalizeSettings', () => {
  it('defaults preserveBrandColors to true on a freshly created site', () => {
    expect(createDefaultSiteSettings().preserveBrandColors).toBe(true);
  });

  it('migrates a legacy mode:"off" site to enabled:false, strategy:"auto"', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { enabled: true, themeId: 'placeholder-theme', mode: 'off' },
      },
    });

    expect(settings.sites['example.com']).toMatchObject({ enabled: false, strategy: 'auto' });
  });

  it('migrates a legacy mode:"aggressive" site to strategy:"auto", preserving enabled', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { enabled: false, themeId: 'placeholder-theme', mode: 'aggressive' },
      },
    });

    expect(settings.sites['example.com']).toMatchObject({ enabled: false, strategy: 'auto' });
  });

  it('passes a v2 entry through unchanged', () => {
    const settings = normalizeSettings({
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

    expect(settings.sites['example.com']).toMatchObject({
      enabled: true,
      strategy: 'variableRemap',
      preserveImages: false,
    });
  });

  it('falls back to strategy:"auto" for an invalid strategy string', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { enabled: true, themeId: 'placeholder-theme', strategy: 'bogus' },
      },
    });

    expect(settings.sites['example.com']).toMatchObject({ strategy: 'auto' });
  });

  it('carries over a legacy preserveBrandColors boolean', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': {
          enabled: true,
          themeId: 'placeholder-theme',
          mode: 'basic',
          preserveBrandColors: false,
        },
      },
    });

    expect(settings.sites['example.com']).toMatchObject({ preserveBrandColors: false });
  });

  it('defaults preserveBrandColors to true for a non-boolean value', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': {
          enabled: true,
          themeId: 'placeholder-theme',
          preserveBrandColors: 'yes',
        },
      },
    });

    expect(settings.sites['example.com']).toMatchObject({ preserveBrandColors: true });
  });

  it('keeps a valid override and drops a garbage one', () => {
    const settings = normalizeSettings({
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': {
          enabled: true,
          themeId: 'placeholder-theme',
          strategy: 'auto',
          overrides: [
            { selector: '.zebra', property: 'color', token: 'text' },
            { selector: '', property: 'color', token: 'text' },
            { selector: '.alpha', property: 'color', token: 'not-a-real-token' },
          ],
        },
      },
    });

    expect(settings.sites['example.com']?.overrides).toEqual([
      { selector: '.zebra', property: 'color', token: 'text' },
    ]);
  });

  it('returns DEFAULT_SETTINGS with schemaVersion 2 for a non-object root', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(2);
  });

  it('returns a fresh clone for garbage input, never the shared DEFAULT_SETTINGS reference', () => {
    const first = normalizeSettings(null);
    const second = normalizeSettings(null);

    expect(first).not.toBe(second);
    expect(first.sites).not.toBe(second.sites);

    first.sites['example.com'] = createDefaultSiteSettings();

    expect(second.sites['example.com']).toBeUndefined();
    expect(DEFAULT_SETTINGS.sites['example.com']).toBeUndefined();
  });
});

describe('pruneThemeReferences', () => {
  it('resets a dangling global theme reference to DEFAULT_THEME_ID', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      globalThemeId: 'imported:deleted-theme',
      sites: {},
    };

    const pruned = pruneThemeReferences(settings, 'imported:deleted-theme');

    expect(pruned).not.toBeNull();
    expect(pruned?.globalThemeId).toBe(DEFAULT_THEME_ID);
  });

  it('remaps a dangling per-site override to the (post-reset) global theme id', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { ...createDefaultSiteSettings(), themeId: 'imported:deleted-theme' },
      },
    };

    const pruned = pruneThemeReferences(settings, 'imported:deleted-theme');

    expect(pruned).not.toBeNull();
    expect(pruned?.globalThemeId).toBe('placeholder-theme');
    expect(pruned?.sites['example.com']?.themeId).toBe('placeholder-theme');
  });

  it('returns null when the deleted theme id is referenced nowhere', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      globalThemeId: 'placeholder-theme',
      sites: {
        'example.com': { ...createDefaultSiteSettings(), themeId: 'placeholder-theme' },
      },
    };

    expect(pruneThemeReferences(settings, 'imported:deleted-theme')).toBeNull();
  });
});
