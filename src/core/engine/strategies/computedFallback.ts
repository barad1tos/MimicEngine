import { installedCensus, type CensusSnapshot } from '../../analyzer/signatureCensus';
import { contrastRatio } from '../../color/contrast';
import { isOpaque, parseCssColor, toHex, type HexColor } from '../../color/parseColor';
import type { PaletteTheme } from '../../themes';
import {
  buildColorMapping,
  extractSitePalette,
  mappingKeyOf,
  themeTokenHex,
  type ColorMapping,
  type SitePaletteEntry,
} from '../colorMap';
import { guardContrast, repairTextTarget } from '../contrastGuard';
import { coverageFromCounts } from '../coverage';
import { planStrategies } from '../decisionTable';
import {
  ELEVATION_LEVELS,
  elevationBackgroundHex,
  elevationLevelForHex,
  elevationVariable,
  shadowVariable,
} from '../elevationScale';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { emitGroupedRules, groupSelectors, type SelectorGroup } from './emitGroupedRules';

// A census color only ever becomes a declaration once its value has parsed
// to a color (see toNovelDeclarations), so `color` is narrowed non-null here
// — same idiom variableRemap.ts uses for its own colored-property subtype.
type NovelDeclaration = AuthoredColorDeclaration & {
  color: NonNullable<AuthoredColorDeclaration['color']>;
};

// The controller builds and installs a live SignatureCensus before
// invoking the plan, so by the time this strategy runs the page has already
// been walked once — no repeat DOM/CSSOM read here. `produce` reads whatever
// census is installed, keeps only colors invisible to the authored-CSS
// analysis (e.g. computed from JS-driven inline styles, canvas-drawn text,
// or other sources collectPageFacts can't see), and reports coverage against
// every distinct opaque color the census actually saw — not just the ones
// this strategy went on to map.
export const computedFallback: PaletteEngine = {
  id: 'computedFallback',
  label: 'Computed fallback',
  produce(theme, siteSettings, facts, plan) {
    const census = installedCensus();
    if (!census) return { css: '' };
    const snapshot = census.snapshot();

    // The stoplist only makes sense when authoredRemap is also running on
    // this plan: it exists to keep the two strategies from double-emitting
    // the same color, not to suppress computedFallback's own coverage. A
    // plan without authoredRemap (e.g. an opaque page where computedFallback
    // is the only strategy that can see the page's colors at all) must
    // remap every opaque color it finds, authored-visible or not.
    const stoplistActive = planStrategies(plan).includes('authoredRemap');
    const authoredHexes = stoplistActive ? collectAuthoredHexes(facts) : new Set<HexColor>();
    const novelDeclarations = toNovelDeclarations(snapshot, authoredHexes);
    const syntheticFacts = buildSyntheticFacts(novelDeclarations);

    const palette = extractSitePalette(syntheticFacts);
    const mapping = buildColorMapping(palette, theme, {
      preserveBrandColors: siteSettings.preserveBrandColors,
    });
    const { mapping: guardedMapping } = guardContrast(mapping, palette, theme);

    const groups = buildSelectorGroups(novelDeclarations, guardedMapping, theme);
    const css = emitGroupedRules(groups);
    const mappedCount = mappedHexCount(palette, guardedMapping);
    // Coverage's denominator must stay disjoint from authoredRemap's own
    // report: distinctColorsSeen counts every opaque value the census saw,
    // authored-covered or not, and summing that with authoredRemap's report
    // in aggregateCoverage double-counts every color both strategies can
    // see (a fully-themed mixed-visibility page reporting ~50% instead of
    // ~100%). When the stoplist is active, only census-seen hexes ABSENT
    // from authoredHexes count as discovered — mirroring which colors
    // toNovelDeclarations kept. When the stoplist is inactive (no
    // authoredRemap in the plan), every hex-deduped opaque value counts, same
    // as before this fix, just deduped by hex rather than by raw string.
    const censusHexes = distinctOpaqueHexes(snapshot.opaqueValuesSeen);
    const discovered = stoplistActive
      ? [...censusHexes].filter((hex) => !authoredHexes.has(hex)).length
      : censusHexes.size;
    const coverage = coverageFromCounts(discovered, mappedCount);

    return { css, coverage };
  },
};

// Mirrors the opacity gate in toNovelDeclarations below (and the one
// collectPageFacts' palette callers use): a translucent authored declaration
// must never suppress an unrelated opaque novel sample that happens to share
// its RGB — toHex drops alpha, so admitting it here would let a 50% scrim
// stop a genuinely opaque color from ever being remapped.
function collectAuthoredHexes(facts: PageFacts): Set<HexColor> {
  const hexes = new Set<HexColor>();

  for (const declaration of [...facts.authoredRules, ...facts.inlineStyleColors]) {
    if (declaration.color && isOpaque(declaration.color)) hexes.add(toHex(declaration.color));
  }
  for (const property of facts.customProperties) {
    if (property.color && isOpaque(property.color)) hexes.add(toHex(property.color));
  }

  return hexes;
}

// Coverage's numerator: the count of DISTINCT RAW HEXES represented in
// `mapping` — not the count of composite (hex@elevation) keys. Elevation
// splits one color into multiple emitted RULES; it does not discover more
// colors, so two same-hex backgrounds mapped at different elevations must
// still count as ONE mapped color against the hex-deduped `discovered`
// denominator below — otherwise mapped can exceed discovered and the ratio
// escapes [0,1] (e.g. one white sampled at two elevations reporting "2/1").
function mappedHexCount(palette: readonly SitePaletteEntry[], mapping: ColorMapping): number {
  const hexes = new Set<HexColor>();

  for (const entry of palette) {
    if (mapping.has(mappingKeyOf(entry))) hexes.add(entry.hex);
  }

  return hexes.size;
}

// Parses every opaque value the census saw into its distinct hexes, dropping
// whatever fails to parse or turns out translucent — defensive, since
// trackOpaque (signatureCensus.ts) only ever adds already-opaque values, but
// this is the coverage denominator's own gate rather than a re-trust of the
// census's internals.
function distinctOpaqueHexes(values: readonly string[]): Set<HexColor> {
  const hexes = new Set<HexColor>();

  for (const value of values) {
    const color = parseCssColor(value);
    if (!color || !isOpaque(color)) continue;
    hexes.add(toHex(color));
  }

  return hexes;
}

// Parses each census color, drops unparseable values, then drops every color
// whose hex is already covered by the authored-CSS analysis — what's left is
// "novel": present in computed style but invisible to collectPageFacts.
// Translucent colors (e.g. a computed `color: rgba(0,0,0,0.5)`) are dropped
// too: toHex discards alpha, so keeping them would let a translucent color
// dedupe against — and later be remapped through — an unrelated opaque
// occurrence of the same RGB.
function toNovelDeclarations(
  snapshot: CensusSnapshot,
  authoredHexes: ReadonlySet<HexColor>,
): NovelDeclaration[] {
  const declarations: NovelDeclaration[] = [];

  for (const entry of snapshot.entries) {
    for (const censusColor of entry.colors) {
      const color = parseCssColor(censusColor.value);
      if (!color) continue;
      if (!isOpaque(color)) continue;
      // Plain-hex comparison, deliberately elevation-blind: an authored rule
      // covering this hex at all means authoredRemap already emits a rule
      // for it, regardless of which stacking depth the census sampled it at.
      if (authoredHexes.has(toHex(color))) continue;

      declarations.push({
        selector: entry.selector,
        property: censusColor.cssProperty,
        value: censusColor.value,
        color,
        bucket: censusColor.bucket,
        // Census colors never carry @media/@supports context —
        // getComputedStyle already resolves the current cascade, so there is
        // no condition chain left to preserve.
        conditions: [],
        ...(censusColor.elevation === undefined ? {} : { elevation: censusColor.elevation }),
      });
    }
  }

  return declarations;
}

// extractSitePalette expects a PageFacts-shaped bag of authored declarations;
// the novel declarations are synthesized into that shape so the same palette
// extraction, color mapping, and contrast guard authoredRemap uses apply here
// unchanged — no parallel palette-building logic to keep in sync.
function buildSyntheticFacts(authoredRules: NovelDeclaration[]): PageFacts {
  return {
    customProperties: [],
    authoredRules,
    inlineStyleColors: [],
    svgPresentationColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    stylesheetCount: 0,
    unreadableStylesheetCount: 0,
  };
}

type ResolvedNovelDeclaration = {
  declaration: NovelDeclaration;
  mappedValue: string;
  isSelectorHint: false;
};

// The ColorMapping identity a raw census declaration occupies — same
// composite hex@elevation rule mappingKeyOf documents, just applied to a
// NovelDeclaration's own parsed color instead of a SitePaletteEntry.
function declarationMappingKey(declaration: NovelDeclaration): string {
  return mappingKeyOf({
    hex: toHex(declaration.color),
    ...(declaration.elevation === undefined ? {} : { elevation: declaration.elevation }),
  });
}

// Groups by selector in first-appearance (census entry) order. Census
// selectors are exact — signatureToSelector derives them from the element's
// own tag/classes (or its refined parent-prefixed form), never a fabricated
// approximation — so the ambiguity-tracking machinery groupSelectors applies
// to hint-based declarations does not apply here.
function buildSelectorGroups(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
  theme: PaletteTheme,
): SelectorGroup[] {
  const resolved: ResolvedNovelDeclaration[] = [];

  for (const declaration of declarations) {
    const mappedValue = mapping.get(declarationMappingKey(declaration));
    if (mappedValue !== undefined)
      resolved.push({ declaration, mappedValue, isSelectorHint: false });
  }

  const backgroundBySelector = buildBackgroundBySelector(declarations, mapping);
  const guarded = applyPairedTextGuard(resolved, backgroundBySelector, theme);
  const withElevationVariables = substituteElevationBackgrounds(guarded, theme);
  const islandShadows = buildIslandShadowDeclarations(guarded);

  return groupSelectors([...withElevationVariables, ...islandShadows]);
}

// The "render-time" substitution the elevation-ramp design calls for:
// guardContrast and the paired-text guard above already ran their contrast
// math against `mappedValue` while it was still a literal HEX (a `var()`
// reference is opaque to contrast checks) — ColorMapping keeps storing real
// hexes end to end, and only the CSS TEXT this strategy emits for a
// background declaration switches to the matching `var(--pm-elevation-N)`.
//
// Two paths, by whether the declaration itself carries a census-derived
// elevation (post-review fix: Sourcery flagged the reverse hex->level lookup
// as lossy on a ramp collision — Amendment 3.5's adjacent-contrast bounce
// can render a non-adjacent rung's hex identically to this one, and
// elevationLevelForHex, a linear scan, can only resolve that first-wins;
// the two levels render identically either way, but the wrong `var()` name
// was still a real mislabel):
// - Elevation-carrying (the common case — assignLadder in colorMap.ts maps
//   this exact declaration.elevation, clamped, onto elevationBackgroundHex):
//   the level is already known, no search needed. Confirm the mapped hex
//   still equals that rung's hex before substituting — an accent-classified
//   background can carry an elevation too (partitionAccents pulls accents
//   out before the ladder ever runs, see colorMap.ts), so its mapped value
//   is a theme accent token, not a ladder rung, and must stay a literal hex.
// - Elevation-less (authoredRemap's palette never carries one; any future
//   hex-only producer): the hex is the only signal available, so the
//   reverse lookup stays here, with the same collision caveat
//   elevationLevelForHex's own docs describe.
// Text and border values are never touched either way.
function substituteElevationBackgrounds(
  resolved: readonly ResolvedNovelDeclaration[],
  theme: PaletteTheme,
): ResolvedNovelDeclaration[] {
  return resolved.map((item) => {
    if (item.declaration.bucket !== 'background') return item;

    const color = parseCssColor(item.mappedValue);
    if (!color) return item;
    const hex = toHex(color);

    const { elevation } = item.declaration;
    if (elevation !== undefined) {
      const level = Math.min(elevation, ELEVATION_LEVELS - 1);
      if (elevationBackgroundHex(theme, level) !== hex) return item;
      return { ...item, mappedValue: `var(${elevationVariable(level)})` };
    }

    const level = elevationLevelForHex(theme, hex);
    if (level === null) return item;

    return { ...item, mappedValue: `var(${elevationVariable(level)})` };
  });
}

const MIN_ISLAND_ELEVATION = 1;

// One synthetic `box-shadow` declaration per selector whose OWN background
// declaration (a) actually resolved through `mapping` — an emitted
// background rule; a preserved/unmapped background casts no shadow — and
// (b) carries an elevation >= 1 (the ground rung, level 0, is flat). The
// shadow's level mirrors the background's own clamped elevation, so an
// island and its shadow always share the same rung; shadowVariable clamps
// internally, so the raw census elevation is passed through unclamped here.
// Deduped by (selector, conditions): a signature has at most one background
// declaration in practice, but this stays correct even if that changes.
// Read from `guarded` (post paired-guard, pre elevation-substitution) —
// only `declaration.bucket`/`elevation` are read, never `mappedValue`, so
// ordering relative to substituteElevationBackgrounds does not matter.
function buildIslandShadowDeclarations(
  guarded: readonly ResolvedNovelDeclaration[],
): ResolvedNovelDeclaration[] {
  const seenSelectors = new Set<string>();
  const shadows: ResolvedNovelDeclaration[] = [];

  for (const { declaration } of guarded) {
    if (declaration.bucket !== 'background') continue;
    const { elevation } = declaration;
    if (elevation === undefined || elevation < MIN_ISLAND_ELEVATION) continue;

    const dedupeKey = `${JSON.stringify(declaration.conditions)}|${declaration.selector}`;
    if (seenSelectors.has(dedupeKey)) continue;
    seenSelectors.add(dedupeKey);

    shadows.push({
      declaration: { ...declaration, property: 'box-shadow' },
      mappedValue: `var(${shadowVariable(elevation)})`,
      isSelectorHint: false,
    });
  }

  return shadows;
}

// A selector's paired background for the guard below: the MAPPED value when
// the declaration resolved through `mapping`, or the declaration's ORIGINAL
// hex when it didn't. An unresolved background-bucket declaration is never
// "missing" data — colorMap.ts's partitionAccents deliberately left it out of
// `mapping` because preserveBrandColors preserves it untouched (C-1), so its
// original color is exactly what ends up on the page and must be what the
// paired guard below checks text against, not a silent skip. Walked over
// ALL declarations, not just `resolved`, so a preserved background still
// gets an entry here even though it never made it into `resolved` itself.
// Source-order iteration means a selector with more than one background
// declaration keeps the last one — same order semantics the prior
// resolved-only map used.
function buildBackgroundBySelector(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
): Map<string, string> {
  const backgroundBySelector = new Map<string, string>();

  for (const declaration of declarations) {
    if (declaration.bucket !== 'background') continue;
    const mappedValue = mapping.get(declarationMappingKey(declaration)) ?? toHex(declaration.color);
    backgroundBySelector.set(declaration.selector, mappedValue);
  }

  return backgroundBySelector;
}

// guardContrast (contrastGuard.ts) already repairs each text-bucket mapping
// against an approximation of "the" page background (its heaviest
// background-bucket entry) — a reasonable global default, but a signature's
// OWN background can be a different, more saturated surface than that
// approximation (an accent-colored pill, a badge), and the global repair
// never sees that pairing. This is the per-selector second pass: when the
// SAME census entry has a paired background (mapped or preserved-original,
// see buildBackgroundBySelector) and a text-bucket mapped value, replace the
// text mapping with pairedTextOverride's result whenever the pair itself
// fails 4.5:1. Border declarations are untouched — only 'text' entries are
// ever replaced. Pure: returns a new array, never mutates `resolved`.
function applyPairedTextGuard(
  resolved: readonly ResolvedNovelDeclaration[],
  backgroundBySelector: ReadonlyMap<string, string>,
  theme: PaletteTheme,
): ResolvedNovelDeclaration[] {
  return resolved.map((entry) => {
    if (entry.declaration.bucket !== 'text') return entry;
    const mappedBackground = backgroundBySelector.get(entry.declaration.selector);
    if (mappedBackground === undefined) return entry;

    const override = pairedTextOverride(entry.mappedValue, mappedBackground, theme);
    return override === null ? entry : { ...entry, mappedValue: override };
  });
}

// null when the pair already clears 4.5:1, or when contrastRatio can't parse
// it (leave untouched — same "no ratio, no repair" contract as
// guardContrast's own text repair). Otherwise the higher-contrast of the
// theme's canvas/text tokens against `mappedBackground` wins (an exact tie
// breaks deterministically on compareStrings of the two candidate hexes) —
// but an imported theme only ever validates its own canvas/text pair against
// EACH OTHER, never against an arbitrary paired background a signature
// happens to sit on, so that "better" candidate can still fail 4.5:1 (C-2).
// When it does, repairTextTarget reruns the SAME lightness-only stepping
// guardContrast's own text repair uses — never a second, drifting
// implementation of it — against the actual paired background, falling back
// to the picked candidate itself if no step clears 4.5 (best-achievable,
// same contract as guardContrast's own fallback semantics).
function pairedTextOverride(
  mappedText: string,
  mappedBackground: string,
  theme: PaletteTheme,
): string | null {
  const ratio = contrastRatio(mappedText, mappedBackground);
  if (ratio === null || ratio >= 4.5) return null;

  const canvasHex = themeTokenHex(theme, 'canvas');
  const textHex = themeTokenHex(theme, 'text');
  const canvasRatio = contrastRatio(canvasHex, mappedBackground) ?? 0;
  const textRatio = contrastRatio(textHex, mappedBackground) ?? 0;
  const picked = pickHigherRatioCandidate(canvasHex, canvasRatio, textHex, textRatio);

  const backgroundColor = parseCssColor(mappedBackground);
  if (!backgroundColor) return picked;

  return repairTextTarget(picked, toHex(backgroundColor), picked);
}

// canvasHex wins on higher ratio; an exact tie breaks deterministically on
// compareStrings of the two candidate hexes (never on iteration order).
function pickHigherRatioCandidate(
  canvasHex: HexColor,
  canvasRatio: number,
  textHex: HexColor,
  textRatio: number,
): HexColor {
  if (canvasRatio !== textRatio) return canvasRatio > textRatio ? canvasHex : textHex;
  return compareStrings(canvasHex, textHex) < 0 ? canvasHex : textHex;
}
