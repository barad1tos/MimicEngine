import { hueDistance, rgbaToOklch, type Oklch } from '../color/oklch';
import { isOpaque, parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme, ThemeTokenName } from '../themes';
import type { AuthoredColorDeclaration, PageFacts } from './pageFacts';
import { compareStrings } from './sort';

export type SitePaletteEntry = {
  hex: HexColor;
  color: RgbaColor;
  weight: number;
  // Dominant declaration context this entry was extracted from — decides
  // which colorMap assignment path (background ladder, text, border, other)
  // it flows into. Not "how it's used" in a CSS sense; a coarse win-by-count
  // bucket over the possible origins (see dominantBucket).
  bucket: AuthoredColorDeclaration['bucket'];
};

// Site hex (lowercase #rrggbb) -> target CSS value. Values are theme token
// HEX literals, never `var(--pm-token)`: the contrast guard needs literal
// pairs to verify against, not indirections.
export type ColorMapping = Map<HexColor, HexColor>;

// A theme token's own configured CSS value, converted to HexColor. Every
// theme token value entering a ColorMapping goes through this (or a direct
// toHex(parseCssColor(...)) call) — never a bare `theme.tokens[x]` string —
// so the branded type actually guarantees what it claims. Throws on an
// invalid theme token, same contract as themeTokenOklch below: theme tokens
// are authored data, not user input, so a parse failure here is a theme bug.
export function themeTokenHex(theme: PaletteTheme, token: ThemeTokenName): HexColor {
  const color = parseCssColor(theme.tokens[token]);
  if (!color) {
    throw new Error(`invalid theme token color for ${token}: ${theme.tokens[token]}`);
  }
  return toHex(color);
}

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

function comparePaletteEntries(a: SitePaletteEntry, b: SitePaletteEntry): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  return compareStrings(a.hex, b.hex);
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
  accumulators: Map<HexColor, PaletteAccumulator>,
): void {
  for (const declaration of declarations) {
    if (isCustomPropertyDeclaration(declaration)) continue;
    if (!declaration.color) continue;
    // A translucent declaration (e.g. rgba(0,0,0,0.5)) never enters the
    // palette: toHex drops alpha, so admitting it here would let it dedupe
    // against — and later stand in for — an unrelated opaque occurrence of
    // the same RGB, turning a 50% scrim into an opaque theme slab.
    if (!isOpaque(declaration.color)) continue;

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
  const accumulators = new Map<HexColor, PaletteAccumulator>();
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
// left off the accent map (null). For non-text buckets that is the end of
// it — the original brand color survives untouched. For the text bucket it
// is only the first half of the story: guardContrast (contrastGuard.ts)
// receives the full site palette independently of this map, notices the
// text-bucket entry is absent here, and decides whether it needs a
// lightness-only legibility repair before the caller ever sees a "preserved"
// color that fails contrast against the page background.
export function mapAccent(
  entry: SitePaletteEntry,
  theme: PaletteTheme,
  preserveBrandColors: boolean,
): HexColor | null {
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

  return themeTokenHex(theme, nearest.token);
}

// Accents are pulled out of their buckets before the bucket steps run: an
// entry is either an accent or a bucket member, never both.
function partitionAccents(
  palette: readonly SitePaletteEntry[],
  theme: PaletteTheme,
  preserveBrandColors: boolean,
): { accents: Map<HexColor, HexColor>; rest: SitePaletteEntry[] } {
  const accents = new Map<HexColor, HexColor>();
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
  assignments: Map<HexColor, HexColor>;
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
    return compareStrings(a.entry.hex, b.entry.hex);
  });

  const assignments = new Map<HexColor, HexColor>();
  const assignedTokens: ThemeTokenName[] = [];
  const seenTokens = new Set<ThemeTokenName>();

  withLightness.forEach(({ entry }, index) => {
    const token = ladderTokenAt(index);
    assignments.set(entry.hex, themeTokenHex(theme, token));
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
): Map<HexColor, HexColor> {
  const sorted = [...entries].sort(comparePaletteEntries);
  const assignments = new Map<HexColor, HexColor>();
  const textHex = themeTokenHex(theme, 'text');
  const textMutedHex = themeTokenHex(theme, 'textMuted');
  sorted.forEach((entry, index) => {
    assignments.set(entry.hex, index === 0 ? textHex : textMutedHex);
  });
  return assignments;
}

function assignBorderBucket(
  entries: readonly SitePaletteEntry[],
  theme: PaletteTheme,
): Map<HexColor, HexColor> {
  const assignments = new Map<HexColor, HexColor>();
  const borderHex = themeTokenHex(theme, 'border');
  for (const entry of entries) {
    assignments.set(entry.hex, borderHex);
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
): Map<HexColor, HexColor> {
  const assignments = new Map<HexColor, HexColor>();
  if (entries.length === 0) return assignments;

  if (ladder.assignedTokens.length === 0) {
    const surface1Hex = themeTokenHex(theme, 'surface1');
    for (const entry of entries) {
      assignments.set(entry.hex, surface1Hex);
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
    assignments.set(entry.hex, themeTokenHex(theme, nearest));
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

  const targetsByHex = new Map<HexColor, HexColor>([
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
