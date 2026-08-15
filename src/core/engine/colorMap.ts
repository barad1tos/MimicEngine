import { hueDistance, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme, ThemeTokenName } from '../themes';
import type { AuthoredColorDeclaration, PageFacts } from './pageFacts';

export type SitePaletteEntry = {
  hex: string;
  color: RgbaColor;
  weight: number;
  bucket: AuthoredColorDeclaration['bucket'];
};

// Site hex (lowercase #rrggbb) -> target CSS value. Values are theme token
// HEX literals, never `var(--pm-token)`: the contrast guard needs literal
// pairs to verify against, not indirections.
export type ColorMapping = Map<string, string>;

type PaletteBucket = AuthoredColorDeclaration['bucket'];

const BUCKET_PRIORITY: readonly PaletteBucket[] = ['background', 'text', 'border', 'other'];
const SURFACE_LADDER: readonly ThemeTokenName[] = ['canvas', 'surface1', 'surface2', 'surface3'];
const ACCENT_TOKEN_ORDER: readonly ThemeTokenName[] = [
  'accent',
  'link',
  'success',
  'warning',
  'danger',
];
const ACCENT_CHROMA_THRESHOLD = 0.09;
const BRAND_PRESERVE_CHROMA_THRESHOLD = 0.14;

function compareHexAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function comparePaletteEntries(a: SitePaletteEntry, b: SitePaletteEntry): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  return compareHexAscending(a.hex, b.hex);
}

// Extraction

type PaletteAccumulator = {
  color: RgbaColor;
  weight: number;
  bucketCounts: Record<PaletteBucket, number>;
};

function isCustomPropertyDeclaration(declaration: AuthoredColorDeclaration): boolean {
  return declaration.property.startsWith('--');
}

function accumulatePaletteEntries(
  declarations: readonly AuthoredColorDeclaration[],
  accumulators: Map<string, PaletteAccumulator>,
): void {
  for (const declaration of declarations) {
    if (isCustomPropertyDeclaration(declaration)) continue;
    if (!declaration.color) continue;

    const hex = toHex(declaration.color);
    const accumulator = accumulators.get(hex) ?? {
      color: declaration.color,
      weight: 0,
      bucketCounts: { background: 0, text: 0, border: 0, other: 0 },
    };
    accumulator.weight += 1;
    accumulator.bucketCounts[declaration.bucket] += 1;
    accumulators.set(hex, accumulator);
  }
}

function dominantBucket(bucketCounts: Record<PaletteBucket, number>): PaletteBucket {
  const max = Math.max(...BUCKET_PRIORITY.map((bucket) => bucketCounts[bucket]));
  return BUCKET_PRIORITY.find((bucket) => bucketCounts[bucket] === max) ?? 'other';
}

// Dedupe by hex, weight = total occurrence count across both source arrays,
// dominant bucket wins ties by background > text > border > other, sorted by
// weight desc then hex asc (codepoint compare). Custom-property declarations
// (`property` starting with `--`) belong to the variableRemap path, not the
// literal palette.
export function extractSitePalette(facts: PageFacts): SitePaletteEntry[] {
  const accumulators = new Map<string, PaletteAccumulator>();
  accumulatePaletteEntries(facts.authoredRules, accumulators);
  accumulatePaletteEntries(facts.inlineStyleColors, accumulators);

  const entries: SitePaletteEntry[] = Array.from(accumulators.entries()).map(
    ([hex, accumulator]) => ({
      hex,
      color: accumulator.color,
      weight: accumulator.weight,
      bucket: dominantBucket(accumulator.bucketCounts),
    }),
  );

  return entries.sort(comparePaletteEntries);
}

// Accents

function themeTokenOklch(theme: PaletteTheme, token: ThemeTokenName): Oklch {
  const color = parseCssColor(theme.tokens[token]);
  if (!color) {
    throw new Error(`invalid theme token color for ${token}: ${theme.tokens[token]}`);
  }
  return rgbaToOklch(color);
}

function isAccentEntry(entry: SitePaletteEntry): boolean {
  return rgbaToOklch(entry.color).c > ACCENT_CHROMA_THRESHOLD;
}

// High-chroma entries map to the hue-nearest of accent/link/success/warning/
// danger (theme tokens' own hues), ties broken by that fixed order. When
// preserveBrandColors is set, entries past the brand-preserve threshold are
// left off the map entirely (null) so the original brand color survives.
export function mapAccent(
  entry: SitePaletteEntry,
  theme: PaletteTheme,
  preserveBrandColors: boolean,
): string | null {
  const entryOklch = rgbaToOklch(entry.color);
  if (preserveBrandColors && entryOklch.c > BRAND_PRESERVE_CHROMA_THRESHOLD) {
    return null;
  }

  const candidates = ACCENT_TOKEN_ORDER.map((token) => ({
    token,
    distance: hueDistance(entryOklch.h, themeTokenOklch(theme, token).h),
  }));

  const nearest = candidates.reduce(
    (best, candidate) => (candidate.distance < best.distance ? candidate : best),
    { token: 'accent', distance: Number.POSITIVE_INFINITY },
  );

  return theme.tokens[nearest.token];
}

// Accents are pulled out of their buckets before the bucket steps run: an
// entry is either an accent or a bucket member, never both.
function partitionAccents(
  palette: readonly SitePaletteEntry[],
  theme: PaletteTheme,
  preserveBrandColors: boolean,
): { accents: Map<string, string>; rest: SitePaletteEntry[] } {
  const accents = new Map<string, string>();
  const rest: SitePaletteEntry[] = [];

  for (const entry of palette) {
    if (!isAccentEntry(entry)) {
      rest.push(entry);
      continue;
    }
    const target = mapAccent(entry, theme, preserveBrandColors);
    if (target !== null) {
      accents.set(entry.hex, target);
    }
  }

  return { accents, rest };
}

// Background ladder

function ladderTokenAt(index: number): ThemeTokenName {
  const clamped = Math.min(index, SURFACE_LADDER.length - 1);
  return SURFACE_LADDER[clamped] ?? 'surface3';
}

type LadderResult = {
  assignments: Map<string, string>;
  // Distinct tokens actually used, in ladder order (canvas, surface1, ...).
  assignedTokens: readonly ThemeTokenName[];
};

// Background-bucket entries sorted by OKLCH `l` (ascending for dark mode,
// descending for light), ties broken by hex asc, then walked onto the theme
// ladder canvas, surface1, surface2, surface3, surface3... (same rung
// semantics as variableRemap's surface ladder).
function assignLadder(entries: readonly SitePaletteEntry[], theme: PaletteTheme): LadderResult {
  const direction = theme.mode === 'dark' ? 1 : -1;
  const withLightness = entries.map((entry) => ({ entry, l: rgbaToOklch(entry.color).l }));

  withLightness.sort((a, b) => {
    const deltaL = (a.l - b.l) * direction;
    if (deltaL !== 0) return deltaL;
    return compareHexAscending(a.entry.hex, b.entry.hex);
  });

  const assignments = new Map<string, string>();
  const assignedTokens: ThemeTokenName[] = [];
  const seenTokens = new Set<ThemeTokenName>();

  withLightness.forEach(({ entry }, index) => {
    const token = ladderTokenAt(index);
    assignments.set(entry.hex, theme.tokens[token]);
    if (!seenTokens.has(token)) {
      seenTokens.add(token);
      assignedTokens.push(token);
    }
  });

  return { assignments, assignedTokens };
}

// Text, border, and other buckets

// Sorted by weight (desc, hex asc tie-break): the heaviest text entry ->
// text, everything else -> textMuted.
function assignTextBucket(
  entries: readonly SitePaletteEntry[],
  theme: PaletteTheme,
): Map<string, string> {
  const sorted = [...entries].sort(comparePaletteEntries);
  const assignments = new Map<string, string>();
  sorted.forEach((entry, index) => {
    assignments.set(entry.hex, index === 0 ? theme.tokens.text : theme.tokens.textMuted);
  });
  return assignments;
}

function assignBorderBucket(
  entries: readonly SitePaletteEntry[],
  theme: PaletteTheme,
): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const entry of entries) {
    assignments.set(entry.hex, theme.tokens.border);
  }
  return assignments;
}

function nearestByLightness(
  candidates: readonly { token: ThemeTokenName; l: number }[],
  targetL: number,
): ThemeTokenName {
  const initial = { token: 'surface1' as ThemeTokenName, l: Number.POSITIVE_INFINITY };
  return candidates.reduce(
    (best, candidate) =>
      Math.abs(candidate.l - targetL) < Math.abs(best.l - targetL) ? candidate : best,
    initial,
  ).token;
}

// 'other'-bucket low-chroma entries map to the nearest of the tokens already
// assigned in the background ladder, by absolute `l` distance (ties -> the
// earlier ladder position). If the ladder assigned nothing (no background
// entries), 'other' falls back to surface1.
function assignOtherBucket(
  entries: readonly SitePaletteEntry[],
  theme: PaletteTheme,
  ladder: LadderResult,
): Map<string, string> {
  const assignments = new Map<string, string>();
  if (entries.length === 0) return assignments;

  if (ladder.assignedTokens.length === 0) {
    for (const entry of entries) {
      assignments.set(entry.hex, theme.tokens.surface1);
    }
    return assignments;
  }

  const tokenLightness = ladder.assignedTokens.map((token) => ({
    token,
    l: themeTokenOklch(theme, token).l,
  }));

  for (const entry of entries) {
    const entryL = rgbaToOklch(entry.color).l;
    const nearest = nearestByLightness(tokenLightness, entryL);
    assignments.set(entry.hex, theme.tokens[nearest]);
  }

  return assignments;
}

// Orchestration

export function buildColorMapping(
  palette: SitePaletteEntry[],
  theme: PaletteTheme,
  options: { preserveBrandColors: boolean },
): ColorMapping {
  const { accents, rest } = partitionAccents(palette, theme, options.preserveBrandColors);

  const backgroundEntries = rest.filter((entry) => entry.bucket === 'background');
  const textEntries = rest.filter((entry) => entry.bucket === 'text');
  const borderEntries = rest.filter((entry) => entry.bucket === 'border');
  const otherEntries = rest.filter((entry) => entry.bucket === 'other');

  const ladder = assignLadder(backgroundEntries, theme);

  const targetsByHex = new Map<string, string>([
    ...accents,
    ...ladder.assignments,
    ...assignTextBucket(textEntries, theme),
    ...assignBorderBucket(borderEntries, theme),
    ...assignOtherBucket(otherEntries, theme, ladder),
  ]);

  // Insert in palette order (weight desc, hex asc) so identical inputs
  // always produce the same Map iteration order.
  const mapping: ColorMapping = new Map();
  for (const entry of palette) {
    const target = targetsByHex.get(entry.hex);
    if (target !== undefined) {
      mapping.set(entry.hex, target);
    }
  }

  return mapping;
}
