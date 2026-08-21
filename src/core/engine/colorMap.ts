import { hueDistance, rgbaToOklch, type Oklch } from '../color/oklch';
import { isOpaque, parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import type { PaletteTheme, ThemeTokenName } from '../themes';
import { ELEVATION_LEVELS, elevationBackgroundHex } from './elevationScale';
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
  // Background-bucket only: stacking depth from signatureCensus's
  // elevationOf. Two background entries sharing a hex at different
  // elevations are distinct surfaces and must not collapse onto the same
  // ladder rung — see mappingKeyOf.
  elevation?: number;
};

// Site identity (hex, or composite hex+elevation for a layered background —
// see mappingKeyOf) -> target CSS value. Values are theme token HEX
// literals, never `var(--pm-token)`: the contrast guard needs literal pairs
// to verify against, not indirections.
export type ColorMapping = Map<string, HexColor>;

// The identity a SitePaletteEntry occupies in a ColorMapping: entries with a
// numeric elevation (background-bucket only) get a composite `hex@elevation`
// key so two same-hex backgrounds at different stacking depths land on
// different ladder rungs instead of colliding; every other entry degrades to
// its plain hex, identical to the pre-elevation behavior.
export function mappingKeyOf(entry: Pick<SitePaletteEntry, 'hex' | 'elevation'>): string {
  return entry.elevation === undefined ? entry.hex : `${entry.hex}@${entry.elevation.toString()}`;
}

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
const ACCENT_TOKEN_ORDER: readonly ThemeTokenName[] = [
  'accent',
  'link',
  'success',
  'warning',
  'danger',
];
const ACCENT_CHROMA_THRESHOLD = 0.09;
export const BRAND_CHROMA_THRESHOLD = 0.14;

function comparePaletteEntries(a: SitePaletteEntry, b: SitePaletteEntry): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  const deltaElevation = (a.elevation ?? 0) - (b.elevation ?? 0);
  if (deltaElevation !== 0) return deltaElevation;
  return compareStrings(a.hex, b.hex);
}

// Extraction

type PaletteAccumulator = {
  hex: HexColor;
  elevation?: number;
  color: RgbaColor;
  weight: number;
  bucketCounts: Record<PaletteBucket, number>;
};

function isCustomPropertyDeclaration(declaration: AuthoredColorDeclaration): boolean {
  return declaration.property.startsWith('--');
}

// A background-bucket declaration's own elevation, or undefined for every
// other bucket — elevation is background-only semantics (see
// AuthoredColorDeclaration and SitePaletteEntry).
function backgroundElevationOf(declaration: AuthoredColorDeclaration): number | undefined {
  return declaration.bucket === 'background' ? declaration.elevation : undefined;
}

function accumulatePaletteEntries(
  declarations: readonly AuthoredColorDeclaration[],
  accumulators: Map<string, PaletteAccumulator>,
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
    const elevation = backgroundElevationOf(declaration);
    // Every declaration's accumulator identity is its plain hex, EXCEPT a
    // background-bucket declaration carrying a numeric elevation: that one
    // dedupes by mappingKeyOf's composite `hex@elevation` instead, so it
    // never merges with — and can never be dominant-bucket-tied against — a
    // non-background declaration of the same hex. A background declaration
    // without elevation (every declaration collectPageFacts itself produces,
    // today) degrades to the plain hex, identical to pre-elevation behavior.
    const key = mappingKeyOf({ hex, ...(elevation === undefined ? {} : { elevation }) });

    const accumulator = accumulators.get(key) ?? {
      hex,
      ...(elevation === undefined ? {} : { elevation }),
      color: declaration.color,
      weight: 0,
      bucketCounts: { background: 0, text: 0, border: 0, other: 0 },
    };
    accumulator.weight += 1;
    accumulator.bucketCounts[declaration.bucket] += 1;
    accumulators.set(key, accumulator);
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

  const entries: SitePaletteEntry[] = Array.from(accumulators.values()).map((accumulator) => ({
    hex: accumulator.hex,
    color: accumulator.color,
    weight: accumulator.weight,
    bucket: dominantBucket(accumulator.bucketCounts),
    ...(accumulator.elevation === undefined ? {} : { elevation: accumulator.elevation }),
  }));

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
  if (preserveBrandColors && entryOklch.c > BRAND_CHROMA_THRESHOLD) {
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
// entry is either an accent or a bucket member, never both. Keyed via
// mappingKeyOf — an accent-classified background entry can still carry an
// elevation, and buildColorMapping's final assembly always looks this map
// up by mappingKeyOf(entry), never the plain hex.
function partitionAccents(
  palette: readonly SitePaletteEntry[],
  theme: PaletteTheme,
  preserveBrandColors: boolean,
): { accents: Map<string, HexColor>; rest: SitePaletteEntry[] } {
  const accents = new Map<string, HexColor>();
  const rest: SitePaletteEntry[] = [];

  for (const entry of palette) {
    if (!isAccentEntry(entry)) {
      rest.push(entry);
      continue;
    }
    const target = mapAccent(entry, theme, preserveBrandColors);
    if (target !== null) {
      accents.set(mappingKeyOf(entry), target);
    }
  }

  return { accents, rest };
}

// Background ladder

const MAX_LADDER_LEVEL = ELEVATION_LEVELS - 1;

function clampLadderLevel(level: number): number {
  return Math.max(0, Math.min(level, MAX_LADDER_LEVEL));
}

type LadderResult = {
  assignments: Map<string, HexColor>;
  // Distinct elevation levels actually assigned (0..3), ascending -- feeds
  // assignOtherBucket's nearest-lightness fallback below.
  assignedLevels: readonly number[];
};

// Background-bucket entries split by elevation presence (Amendment 3:
// depth is an engine-owned, theme-universal ramp, never the theme's own
// surface1-3 tokens):
// - A census-sourced entry (signatureCensus's elevationOf -- always set for
//   a background-bucket sample, see toNovelDeclarations) maps DIRECTLY onto
//   `elevationBackgroundHex(theme, min(entry.elevation, 3))`. Elevation is
//   already an engine-recognized stacking LEVEL, not a relative ordering
//   among this page's sampled colors -- two entries sharing an elevation
//   collapse onto the SAME rung regardless of their raw site hex or
//   luminance (they are the same visual surface).
// - An entry with no elevation (authoredRemap's palette never carries one)
//   keeps the pre-elevation index-walk: sorted by OKLCH `l` (ascending for
//   dark mode, descending for light) among themselves, ties broken by hex
//   asc, walked onto elevation levels 0, 1, 2, 3, 3... in order.
// Both branches target the same derived hex space and are assigned via
// mappingKeyOf, so a census entry's composite `hex@elevation` key never
// collides with an elevation-less entry's plain hex key.
function assignLadder(entries: readonly SitePaletteEntry[], theme: PaletteTheme): LadderResult {
  const direction = theme.mode === 'dark' ? 1 : -1;
  const assignments = new Map<string, HexColor>();
  const levelsUsed = new Set<number>();

  const withElevation = entries.filter((entry) => entry.elevation !== undefined);
  const withoutElevation = entries.filter((entry) => entry.elevation === undefined);

  for (const entry of withElevation) {
    const level = clampLadderLevel(entry.elevation ?? 0);
    assignments.set(mappingKeyOf(entry), elevationBackgroundHex(theme, level));
    levelsUsed.add(level);
  }

  const withLightness = withoutElevation.map((entry) => ({ entry, l: rgbaToOklch(entry.color).l }));
  withLightness.sort((a, b) => {
    const deltaL = (a.l - b.l) * direction;
    if (deltaL !== 0) return deltaL;
    return compareStrings(a.entry.hex, b.entry.hex);
  });

  withLightness.forEach(({ entry }, index) => {
    const level = clampLadderLevel(index);
    assignments.set(mappingKeyOf(entry), elevationBackgroundHex(theme, level));
    levelsUsed.add(level);
  });

  const assignedLevels = [...levelsUsed].sort((a, b) => a - b);
  return { assignments, assignedLevels };
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
  candidates: readonly { level: number; l: number }[],
  targetL: number,
): number {
  const initial = { level: 0, l: Number.POSITIVE_INFINITY };
  return candidates.reduce(
    (best, candidate) =>
      Math.abs(candidate.l - targetL) < Math.abs(best.l - targetL) ? candidate : best,
    initial,
  ).level;
}

// The OKLCH lightness of one elevation level's derived background, for
// nearest-lightness comparison in assignOtherBucket below. elevationBackgroundHex
// always returns a parseable hex (it round-trips through toHex itself), so a
// parse failure here means a corrupted HexColor reached this function.
function elevationLightnessAt(theme: PaletteTheme, level: number): number {
  const hexValue = elevationBackgroundHex(theme, level);
  const color = parseCssColor(hexValue);
  if (!color) {
    throw new Error(`invalid derived elevation color for level ${level.toString()}: ${hexValue}`);
  }
  return rgbaToOklch(color).l;
}

// 'other'-bucket low-chroma entries map to the nearest elevation level
// already assigned in the background ladder, by absolute `l` distance (ties
// -> the earlier ladder position). If the ladder assigned nothing (no
// background entries), 'other' falls back to the theme's own surface1 token
// -- there is no elevation ramp to fall back to when nothing anchors it.
function assignOtherBucket(
  entries: readonly SitePaletteEntry[],
  theme: PaletteTheme,
  ladder: LadderResult,
): Map<HexColor, HexColor> {
  const assignments = new Map<HexColor, HexColor>();
  if (entries.length === 0) return assignments;

  if (ladder.assignedLevels.length === 0) {
    const surface1Hex = themeTokenHex(theme, 'surface1');
    for (const entry of entries) {
      assignments.set(entry.hex, surface1Hex);
    }
    return assignments;
  }

  const levelLightness = ladder.assignedLevels.map((level) => ({
    level,
    l: elevationLightnessAt(theme, level),
  }));

  for (const entry of entries) {
    const entryL = rgbaToOklch(entry.color).l;
    const nearestLevel = nearestByLightness(levelLightness, entryL);
    assignments.set(entry.hex, elevationBackgroundHex(theme, nearestLevel));
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

  const targetsByKey = new Map<string, HexColor>([
    ...accents,
    ...ladder.assignments,
    ...assignTextBucket(textEntries, theme),
    ...assignBorderBucket(borderEntries, theme),
    ...assignOtherBucket(otherEntries, theme, ladder),
  ]);

  // Insert in palette order (weight desc, hex asc) so identical inputs
  // always produce the same Map iteration order. Keyed via mappingKeyOf
  // throughout: it degrades to the plain hex for every entry outside the
  // elevation-bearing background ladder, so this is a no-op for those.
  const mapping: ColorMapping = new Map();
  for (const entry of palette) {
    const target = targetsByKey.get(mappingKeyOf(entry));
    if (target !== undefined) {
      mapping.set(mappingKeyOf(entry), target);
    }
  }

  return mapping;
}
