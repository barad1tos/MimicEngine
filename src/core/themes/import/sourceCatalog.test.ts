import { describe, expect, it } from 'vitest';
import { orderSourceCards, SOURCE_CATALOG } from './sourceCatalog';

const CATALOG_IDS = SOURCE_CATALOG.map((card) => card.id);
const NON_FILE_CATALOG_IDS = CATALOG_IDS.filter((id) => id !== 'file');

describe('SOURCE_CATALOG', () => {
  it('declares the expected sources in a fixed catalog order', () => {
    expect(CATALOG_IDS).toEqual([
      'jetbrains',
      'vscode',
      'iterm',
      'alacritty',
      'kitty',
      'ghostty',
      'file',
    ]);
  });

  it('gives every non-file card at least one path or instructions', () => {
    for (const card of SOURCE_CATALOG) {
      if (card.id === 'file') continue;
      const hasAnyPath = Object.values(card.paths).some((paths) => paths.length > 0);
      expect(hasAnyPath || card.instructions !== undefined).toBe(true);
    }
  });

  it('gives every non-file card non-empty picker extensions', () => {
    for (const card of SOURCE_CATALOG) {
      if (card.id === 'file') continue;
      expect(card.pickerExtensions.length).toBeGreaterThan(0);
    }
  });

  it('gives every declared path array at least one entry (no empty platform arrays)', () => {
    for (const card of SOURCE_CATALOG) {
      for (const paths of Object.values(card.paths)) {
        expect(paths.length).toBeGreaterThan(0);
      }
    }
  });

  it('makes the file card a paths-free, instructions-free, extension-free catch-all', () => {
    const fileCard = SOURCE_CATALOG.find((card) => card.id === 'file');
    expect(fileCard).toBeDefined();
    expect(fileCard?.paths).toEqual({});
    expect(fileCard?.instructions).toBeUndefined();
    expect(fileCard?.pickerExtensions).toEqual([]);
  });

  it('gives every card a non-empty label and readonly formats array', () => {
    for (const card of SOURCE_CATALOG) {
      expect(card.label.length).toBeGreaterThan(0);
      expect(Array.isArray(card.formats)).toBe(true);
    }
  });
});

describe('orderSourceCards', () => {
  it('is a pure function: identical inputs produce an identical, deep-equal array', () => {
    const first = orderSourceCards(['kitty', 'vscode'], 'mac');
    const second = orderSourceCards(['kitty', 'vscode'], 'mac');
    expect(first).toEqual(second);
    expect(first.map((card) => card.id)).toEqual(second.map((card) => card.id));
  });

  it('returns every catalog card exactly once', () => {
    const ordered = orderSourceCards([], 'mac');
    const localeCompare = (a: string, b: string) => a.localeCompare(b);
    expect(ordered.map((card) => card.id).sort(localeCompare)).toEqual(
      [...CATALOG_IDS].sort(localeCompare),
    );
  });

  it('floats recent sources first, in recentSources order, not catalog order', () => {
    const ordered = orderSourceCards(['ghostty', 'jetbrains'], 'mac');
    expect(ordered.slice(0, 2).map((card) => card.id)).toEqual(['ghostty', 'jetbrains']);
  });

  it('keeps the file card last even when it appears in recentSources', () => {
    const ordered = orderSourceCards(['file', 'kitty'], 'mac');
    expect(ordered.at(-1)?.id).toBe('file');
    expect(ordered[0]?.id).toBe('kitty');
  });

  it('keeps the file card last when recentSources is empty', () => {
    const ordered = orderSourceCards([], 'windows');
    expect(ordered.at(-1)?.id).toBe('file');
  });

  it('orders platform-relevant non-recent cards before the rest, for mac', () => {
    // On mac every non-file card has either paths or instructions, so nothing
    // should fall into the trailing "rest" group ahead of platform-relevant ones.
    const ordered = orderSourceCards([], 'mac');
    const nonFileIds = ordered.filter((card) => card.id !== 'file').map((card) => card.id);
    expect(nonFileIds).toEqual(['jetbrains', 'vscode', 'iterm', 'alacritty', 'kitty', 'ghostty']);
  });

  it('demotes cards with neither windows paths nor instructions behind windows-relevant ones', () => {
    const ordered = orderSourceCards([], 'windows');
    const alacrittyIndex = ordered.findIndex((card) => card.id === 'alacritty');
    const vscodeIndex = ordered.findIndex((card) => card.id === 'vscode');
    // vscode declares windows paths; alacritty declares none and has no
    // instructions, so it must rank behind every windows-relevant card.
    expect(vscodeIndex).toBeLessThan(alacrittyIndex);
  });

  it('preserves catalog order within the platform-relevant group', () => {
    const ordered = orderSourceCards([], 'linux');
    const relevantIds = ordered
      .filter((card) => card.id !== 'file')
      .map((card) => card.id)
      .filter((id) => NON_FILE_CATALOG_IDS.includes(id));
    // Catalog order is jetbrains, vscode, iterm, alacritty, kitty, ghostty —
    // the returned relative order must match regardless of grouping.
    const catalogRank = new Map(NON_FILE_CATALOG_IDS.map((id, index) => [id, index]));
    const ranks = relevantIds.map((id) => catalogRank.get(id) ?? -1);
    const sortedRanks = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sortedRanks);
  });

  it('silently ignores recentSources ids that are not in the catalog', () => {
    const withStale = orderSourceCards(['not-a-real-source', 'kitty'], 'mac');
    const withoutStale = orderSourceCards(['kitty'], 'mac');
    expect(withStale.map((card) => card.id)).toEqual(withoutStale.map((card) => card.id));
    expect(withStale.some((card) => card.id === 'not-a-real-source')).toBe(false);
  });

  it('deduplicates a repeated id in recentSources without reordering the rest', () => {
    const ordered = orderSourceCards(['kitty', 'kitty', 'jetbrains'], 'mac');
    expect(ordered.filter((card) => card.id === 'kitty')).toHaveLength(1);
    expect(ordered.slice(0, 2).map((card) => card.id)).toEqual(['kitty', 'jetbrains']);
  });

  it('does not mutate SOURCE_CATALOG', () => {
    const before = SOURCE_CATALOG.map((card) => card.id);
    orderSourceCards(['ghostty', 'file', 'vscode'], 'linux');
    expect(SOURCE_CATALOG.map((card) => card.id)).toEqual(before);
  });
});
