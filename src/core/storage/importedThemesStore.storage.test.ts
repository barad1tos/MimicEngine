import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import type { ThemeTokens } from '../themes';
import type { createStorageArea } from '../testing/storageArea';
import {
  deleteImportedTheme,
  IMPORTED_THEMES_KEY,
  importedThemeId,
  normalizeImportedThemes,
  readImportedThemes,
  readRecentSources,
  saveImportedTheme,
  slugifyThemeName,
  type ImportedTheme,
} from './importedThemesStore';

// `createStorageArea` is imported dynamically inside the factory (rather
// than referenced from a static top-level import) because vi.mock factories
// are hoisted above the file's own import statements — a static reference
// here would throw a TDZ error at module-eval time.
vi.mock('wxt/browser', async () => {
  const { createStorageArea } = await import('../testing/storageArea');

  return {
    browser: {
      storage: {
        local: createStorageArea(),
      },
    },
  };
});

const fakeBrowser = browser as unknown as {
  storage: { local: ReturnType<typeof createStorageArea> };
};

afterEach(() => {
  fakeBrowser.storage.local.data.clear();
  fakeBrowser.storage.local.get.mockClear();
  fakeBrowser.storage.local.set.mockClear();
});

function makeTokens(): ThemeTokens {
  return {
    canvas: '#1f2430',
    surface1: '#242936',
    surface2: '#2b3242',
    surface3: '#343f4a',
    text: '#cbccc6',
    textMuted: '#707a8c',
    border: '#343f4a',
    accent: '#ffcc66',
    link: '#5ccfe6',
    success: '#bae67e',
    warning: '#ffd580',
    danger: '#ff6666',
    selection: '#34455a',
    focus: '#5ccfe6',
  };
}

function makeRawImportedTheme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'imported:test-theme',
    name: 'Test Theme',
    mode: 'dark',
    sourceFormat: 'vscode',
    tokens: makeTokens(),
    ...overrides,
  };
}

describe('slugifyThemeName', () => {
  it('lowercases, collapses non-alphanumeric runs to a single dash, and trims edges', () => {
    expect(slugifyThemeName('Ayu Mirage!')).toBe('ayu-mirage');
    expect(slugifyThemeName('  Multiple   Spaces  ')).toBe('multiple-spaces');
    expect(slugifyThemeName('C++ Dark_Mode')).toBe('c-dark-mode');
  });
});

describe('importedThemeId', () => {
  it('prefixes the slug with imported:', () => {
    expect(importedThemeId('Ayu Mirage!')).toBe('imported:ayu-mirage');
  });
});

describe('normalizeImportedThemes', () => {
  it('returns empty state for non-object input', () => {
    expect(normalizeImportedThemes('nonsense')).toEqual({
      schemaVersion: 1,
      themes: [],
      recentSources: [],
    });
    expect(normalizeImportedThemes(undefined)).toEqual({
      schemaVersion: 1,
      themes: [],
      recentSources: [],
    });
  });

  it('drops a corrupt entry item-wise while keeping a valid sibling', () => {
    const valid = makeRawImportedTheme();
    const corruptMissingToken = makeRawImportedTheme({
      id: 'imported:corrupt-missing-token',
      tokens: { ...makeTokens(), focus: undefined },
    });
    const corruptBadMode = makeRawImportedTheme({ id: 'imported:corrupt-mode', mode: 'sepia' });
    const corruptBadId = makeRawImportedTheme({ id: 'not-imported-prefixed' });
    const corruptBadSourceFormat = makeRawImportedTheme({
      id: 'imported:corrupt-source',
      sourceFormat: 'photoshop',
    });
    const corruptNonStringName = makeRawImportedTheme({ id: 'imported:corrupt-name', name: 42 });
    const corruptTranslucentToken = makeRawImportedTheme({
      id: 'imported:corrupt-alpha',
      tokens: { ...makeTokens(), canvas: 'rgba(0, 0, 0, 0.5)' },
    });

    const result = normalizeImportedThemes({
      schemaVersion: 1,
      themes: [
        valid,
        corruptMissingToken,
        corruptBadMode,
        corruptBadId,
        corruptBadSourceFormat,
        corruptNonStringName,
        corruptTranslucentToken,
        'not-an-object',
      ],
      recentSources: [],
    });

    expect(result.themes).toEqual([valid]);
  });

  it('caps recentSources at 7 and drops duplicates, keeping first occurrence', () => {
    const result = normalizeImportedThemes({
      schemaVersion: 1,
      themes: [],
      recentSources: ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g', 'h'],
    });

    expect(result.recentSources).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('dedupes entries sharing an id, keeping the last values at the first occurrence position', () => {
    const first = makeRawImportedTheme({ tokens: { ...makeTokens(), canvas: '#111111' } });
    const last = makeRawImportedTheme({ tokens: { ...makeTokens(), canvas: '#222222' } });

    const result = normalizeImportedThemes({
      schemaVersion: 1,
      themes: [first, last],
      recentSources: [],
    });

    expect(result.themes).toHaveLength(1);
    expect(result.themes[0]).toMatchObject({
      id: 'imported:test-theme',
      tokens: { canvas: '#222222' },
    });
  });

  it('preserves the order of non-duplicate ids interleaved around a deduped id', () => {
    const dupFirst = makeRawImportedTheme({ tokens: { ...makeTokens(), canvas: '#111111' } });
    const other1 = makeRawImportedTheme({ id: 'imported:other-one', name: 'Other One' });
    const dupLast = makeRawImportedTheme({ tokens: { ...makeTokens(), canvas: '#222222' } });
    const other2 = makeRawImportedTheme({ id: 'imported:other-two', name: 'Other Two' });

    const result = normalizeImportedThemes({
      schemaVersion: 1,
      themes: [dupFirst, other1, dupLast, other2],
      recentSources: [],
    });

    expect(result.themes.map((theme) => theme.id)).toEqual([
      'imported:test-theme',
      'imported:other-one',
      'imported:other-two',
    ]);
    expect(result.themes[0]).toMatchObject({ tokens: { canvas: '#222222' } });
  });
});

describe('readImportedThemes', () => {
  it('returns [] when storage is empty', async () => {
    expect(await readImportedThemes()).toEqual([]);
  });

  it('returns normalized themes read through browser.storage.local', async () => {
    const raw = makeRawImportedTheme();
    fakeBrowser.storage.local.data.set(IMPORTED_THEMES_KEY, {
      schemaVersion: 1,
      themes: [raw],
      recentSources: [],
    });

    const themes = await readImportedThemes();

    expect(themes).toEqual([raw]);
    expect(fakeBrowser.storage.local.get).toHaveBeenCalledWith(IMPORTED_THEMES_KEY);
  });
});

describe('readRecentSources', () => {
  it('returns [] when storage is empty', async () => {
    expect(await readRecentSources()).toEqual([]);
  });
});

describe('saveImportedTheme', () => {
  const themeInput: Omit<ImportedTheme, 'id'> = {
    name: 'Ayu Mirage!',
    mode: 'dark',
    sourceFormat: 'vscode',
    tokens: makeTokens(),
  };

  it('assembles id from the slugified name', async () => {
    const saved = await saveImportedTheme(themeInput, 'card-1');
    expect(saved.id).toBe('imported:ayu-mirage');
  });

  it('replaces an existing entry with the same slug, keeping its position', async () => {
    const other: Omit<ImportedTheme, 'id'> = {
      name: 'Other Theme',
      mode: 'light',
      sourceFormat: 'iterm',
      tokens: makeTokens(),
    };

    await saveImportedTheme(themeInput, 'card-1');
    await saveImportedTheme(other, 'card-2');
    await saveImportedTheme({ ...themeInput, mode: 'light' }, 'card-3');

    const themes = await readImportedThemes();

    expect(themes).toHaveLength(2);
    expect(themes[0]).toMatchObject({ id: 'imported:ayu-mirage', mode: 'light' });
    expect(themes[1]).toMatchObject({ id: 'imported:other-theme' });
  });

  it('prepends sourceCardId to recentSources, deduped and capped at 7', async () => {
    await saveImportedTheme({ ...themeInput, name: 'One' }, 'card-a');
    await saveImportedTheme({ ...themeInput, name: 'Two' }, 'card-b');
    await saveImportedTheme({ ...themeInput, name: 'Three' }, 'card-a');

    expect(await readRecentSources()).toEqual(['card-a', 'card-b']);
  });

  it('round-trips a theme with an author through save and read', async () => {
    const saved = await saveImportedTheme(
      { ...themeInput, name: 'Ayu Mirage With Author', author: 'cloud' },
      'card-1',
    );
    expect(saved.author).toBe('cloud');

    const themes = await readImportedThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ id: saved.id, author: 'cloud' });
  });
});

describe('deleteImportedTheme', () => {
  it('removes the matching entry and leaves others intact', async () => {
    const themeInput: Omit<ImportedTheme, 'id'> = {
      name: 'Ayu Mirage!',
      mode: 'dark',
      sourceFormat: 'vscode',
      tokens: makeTokens(),
    };
    const other: Omit<ImportedTheme, 'id'> = {
      name: 'Other Theme',
      mode: 'light',
      sourceFormat: 'iterm',
      tokens: makeTokens(),
    };

    await saveImportedTheme(themeInput, 'card-1');
    await saveImportedTheme(other, 'card-2');

    await deleteImportedTheme('imported:ayu-mirage');

    const themes = await readImportedThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ id: 'imported:other-theme' });
  });

  it('is a no-op when the id is absent', async () => {
    await expect(deleteImportedTheme('imported:does-not-exist')).resolves.toBeUndefined();
    expect(await readImportedThemes()).toEqual([]);
  });
});
