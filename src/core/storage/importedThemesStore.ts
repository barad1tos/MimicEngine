import { browser } from 'wxt/browser';
import { isOpaque, parseCssColor } from '../color/parseColor';
import {
  THEME_TOKEN_NAMES,
  type PaletteTheme,
  type ThemeTokenName,
  type ThemeTokens,
} from '../themes';
import type { SourceFormatId } from '../themes/import/importTypes';

export type ImportedTheme = PaletteTheme & { sourceFormat: SourceFormatId };

export const IMPORTED_THEMES_KEY = 'palette-mimicry:imported-themes';

const RECENT_SOURCES_CAP = 7;

const SOURCE_FORMAT_IDS: readonly SourceFormatId[] = [
  'jetbrains-ui',
  'jetbrains-editor',
  'vscode',
  'iterm',
  'alacritty',
  'kitty',
  'ghostty',
];

type ImportedThemesState = {
  schemaVersion: 1;
  themes: ImportedTheme[];
  recentSources: string[];
};

const EMPTY_STATE: ImportedThemesState = { schemaVersion: 1, themes: [], recentSources: [] };

// lowercase, collapse any run of non-alphanumeric characters to a single
// '-', then trim leading/trailing '-'. E.g. 'Ayu Mirage!' -> 'ayu-mirage'.
export function slugifyThemeName(name: string): string {
  return trimDashes(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

// Manual index-walk instead of a `/^-+|-+$/`-style regex: sonarjs flags
// anchored quantifiers like that as super-linear (backtracking risk on
// pathological input), even though this call site is safe.
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

export function importedThemeId(name: string): string {
  return `imported:${slugifyThemeName(name)}`;
}

export function normalizeImportedThemes(value: unknown): ImportedThemesState {
  if (!isObject(value)) return EMPTY_STATE;

  return {
    schemaVersion: 1,
    themes: normalizeThemes(value.themes),
    recentSources: normalizeRecentSources(value.recentSources),
  };
}

export async function readImportedThemes(): Promise<ImportedTheme[]> {
  const result = await browser.storage.local.get(IMPORTED_THEMES_KEY);
  return normalizeImportedThemes(result[IMPORTED_THEMES_KEY]).themes;
}

export async function readRecentSources(): Promise<string[]> {
  const result = await browser.storage.local.get(IMPORTED_THEMES_KEY);
  return normalizeImportedThemes(result[IMPORTED_THEMES_KEY]).recentSources;
}

export async function saveImportedTheme(
  theme: Omit<ImportedTheme, 'id'>,
  sourceCardId: string,
): Promise<ImportedTheme> {
  const assembled: ImportedTheme = { ...theme, id: importedThemeId(theme.name) };

  const result = await browser.storage.local.get(IMPORTED_THEMES_KEY);
  const current = normalizeImportedThemes(result[IMPORTED_THEMES_KEY]);

  // Replace-in-place keeps the existing entry's position stable across
  // re-imports (rather than removing + re-appending), so the options
  // page's theme list doesn't reorder itself when a theme is re-saved
  // under the same slug.
  const existingIndex = current.themes.findIndex((existing) => existing.id === assembled.id);
  const themes =
    existingIndex === -1
      ? [...current.themes, assembled]
      : current.themes.map((existing, index) => (index === existingIndex ? assembled : existing));

  const next = normalizeImportedThemes({
    schemaVersion: 1,
    themes,
    recentSources: [sourceCardId, ...current.recentSources],
  });

  await browser.storage.local.set({ [IMPORTED_THEMES_KEY]: next });
  return assembled;
}

export async function deleteImportedTheme(id: string): Promise<void> {
  const result = await browser.storage.local.get(IMPORTED_THEMES_KEY);
  const current = normalizeImportedThemes(result[IMPORTED_THEMES_KEY]);
  const themes = current.themes.filter((theme) => theme.id !== id);

  await browser.storage.local.set({
    [IMPORTED_THEMES_KEY]: normalizeImportedThemes({ ...current, themes }),
  });
}

// Invariant: themes are unique by id. This funnel enforces it on every read
// and write, so a duplicate id -- e.g. from saveImportedTheme's non-atomic
// read-modify-write racing under overlapping saves -- self-heals on the
// next pass through here. On a duplicate, the later entry's values win
// (keep-last, consistent with replace-on-re-import semantics), but the
// surviving entry stays at the FIRST occurrence's list position, so list
// order doesn't jump around just because a duplicate happened to exist.
function normalizeThemes(value: unknown): ImportedTheme[] {
  if (!Array.isArray(value)) return [];

  const themes: ImportedTheme[] = [];
  const indexById = new Map<string, number>();

  for (const entry of value) {
    const theme = normalizeImportedTheme(entry);
    if (!theme) continue;

    const existingIndex = indexById.get(theme.id);
    if (existingIndex === undefined) {
      indexById.set(theme.id, themes.length);
      themes.push(theme);
    } else {
      themes[existingIndex] = theme;
    }
  }

  return themes;
}

function normalizeImportedTheme(value: unknown): ImportedTheme | null {
  if (!isObject(value)) return null;
  if (typeof value.id !== 'string' || !value.id.startsWith('imported:')) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;
  if (value.mode !== 'dark' && value.mode !== 'light') return null;
  if (!isSourceFormatId(value.sourceFormat)) return null;

  const tokens = normalizeThemeTokens(value.tokens);
  if (!tokens) return null;

  return {
    id: value.id,
    name: value.name,
    mode: value.mode,
    sourceFormat: value.sourceFormat,
    tokens,
    ...(typeof value.author === 'string' ? { author: value.author } : {}),
  };
}

function normalizeThemeTokens(value: unknown): ThemeTokens | null {
  if (!isObject(value)) return null;

  const tokens: Partial<Record<ThemeTokenName, string>> = {};
  for (const tokenName of THEME_TOKEN_NAMES) {
    const rawToken = value[tokenName];
    if (typeof rawToken !== 'string') return null;

    const parsed = parseCssColor(rawToken);
    if (!parsed || !isOpaque(parsed)) return null;

    tokens[tokenName] = rawToken;
  }

  return isThemeTokens(tokens) ? tokens : null;
}

function isThemeTokens(value: Partial<Record<ThemeTokenName, string>>): value is ThemeTokens {
  return THEME_TOKEN_NAMES.every((tokenName) => typeof value[tokenName] === 'string');
}

function normalizeRecentSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const deduped: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (deduped.includes(entry)) continue;

    deduped.push(entry);
    if (deduped.length === RECENT_SOURCES_CAP) break;
  }
  return deduped;
}

function isSourceFormatId(value: unknown): value is SourceFormatId {
  return typeof value === 'string' && (SOURCE_FORMAT_IDS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
