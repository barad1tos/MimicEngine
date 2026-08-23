import { installedCensus, type CensusSnapshot } from '../../analyzer/signatureCensus';
import { isLeafClassSuperset } from '../../analyzer/styleSignature';
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
  elevationVariable,
  shadowVariable,
} from '../elevationScale';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { groupSelectors, type StyleRule } from '../stylePlan';

// A census color only ever becomes a declaration once its value has parsed
// to a color (see toNovelDeclarations), so `color` is narrowed non-null here
// — same idiom variableRemap.ts uses for its own colored-property subtype.
// `signature` is the raw census key the selector was derived from: emitted
// selectors are CSS-escaped and unsafe to parse back, so the superset-bleed
// math below operates on signatures.
type NovelDeclaration = AuthoredColorDeclaration & {
  color: NonNullable<AuthoredColorDeclaration['color']>;
  signature: string;
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
    if (!census) return { content: { kind: 'rules', rules: [] } };
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

    const rules = buildRules(novelDeclarations, guardedMapping, theme);
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

    return { content: { kind: 'rules', rules }, coverage };
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
        signature: entry.signature,
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
function buildRules(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
  theme: PaletteTheme,
): StyleRule[] {
  const resolved: ResolvedNovelDeclaration[] = [];

  for (const declaration of declarations) {
    const mappedValue = mapping.get(declarationMappingKey(declaration));
    if (mappedValue !== undefined)
      resolved.push({ declaration, mappedValue, isSelectorHint: false });
  }

  const backgroundBySelector = buildBackgroundBySelector(declarations, mapping);
  const guarded = guardSurfaceText(resolved, declarations, backgroundBySelector, theme);
  const { substituted, islands, followers } = substituteElevationBackgrounds(guarded, theme);

  return [
    ...buildPositionalGroups(new Set(islands.values())),
    ...buildBleedResets(islands, followers),
    ...groupSelectors(substituted),
  ];
}

// Inherited by descendants, so a surface-following rule painted inside a
// level-N island automatically reads that island's rung; unset outside
// every island, where the follower substitution's fallback lands the
// ground rung. Set only by the positional block below.
const CURRENT_SURFACE_VARIABLE = '--pm-current-surface';

// `islands` and `followers` map raw signature -> emitted selector for the
// background declarations the substitution below classified either way:
// the signature side feeds the superset-bleed math (selectors are
// CSS-escaped, unsafe to parse back), the selector side the emitted rules.
type ElevationSubstitution = {
  substituted: ResolvedNovelDeclaration[];
  islands: ReadonlyMap<string, string>;
  followers: ReadonlyMap<string, string>;
};

// The "render-time" split positional elevation (Amendment 3.7) calls for:
// guardContrast and the paired-text guard above already ran their contrast
// math against `mappedValue` while it was still a literal HEX (a `var()`
// reference is opaque to contrast checks) — ColorMapping keeps storing real
// hexes end to end; only the emitted CSS changes shape here. A background
// declaration is judged by its census-derived BINARY elevation against the
// rung hex assignLadder (colorMap.ts) gave it:
// - Island (elevation 1, mapped onto the rung-1 hex): REMOVED from the
//   per-signature output entirely — its background and shadow are painted
//   by the positional block, which is the only place depth exists now. Its
//   selector joins the returned island set.
// - Follower (elevation 0, mapped onto the ground rung): substituted to the
//   inherited surface variable with the ground rung as fallback, so one
//   signature reads the right tone at every depth.
// - Anything else — accent-classified backgrounds (partitionAccents pulls
//   accents out before the ladder runs, so their mapped value is a theme
//   accent token, never a rung hex), preserved/unmapped values, text and
//   border buckets: untouched.
// Census background declarations always carry an elevation
// (recordBackgroundExtras computes it for every opaque sample), so there is
// no elevation-less background path left — the old reverse hex->level
// lookup died with it.
function substituteElevationBackgrounds(
  resolved: readonly ResolvedNovelDeclaration[],
  theme: PaletteTheme,
): ElevationSubstitution {
  const substituted: ResolvedNovelDeclaration[] = [];
  const islands = new Map<string, string>();
  const followers = new Map<string, string>();

  for (const item of resolved) {
    const rung = mappedRungLevel(item, theme);
    if (rung === null) {
      substituted.push(item);
      continue;
    }

    if (rung >= 1) {
      islands.set(item.declaration.signature, item.declaration.selector);
      continue;
    }

    followers.set(item.declaration.signature, item.declaration.selector);
    substituted.push({
      ...item,
      mappedValue: `var(${CURRENT_SURFACE_VARIABLE}, var(${elevationVariable(0)}))`,
    });
  }

  return { substituted, islands, followers };
}

// The elevation level a background declaration's mapped value actually
// occupies on the tonal ramp, or null when the substitution above must
// leave it alone: not a background, no census elevation, or a mapped hex
// that is not that level's rung (an accent-classified background carries an
// elevation too, but its mapped value is an accent token, not a rung).
function mappedRungLevel(item: ResolvedNovelDeclaration, theme: PaletteTheme): number | null {
  if (item.declaration.bucket !== 'background') return null;
  const { elevation } = item.declaration;
  if (elevation === undefined) return null;

  const color = parseCssColor(item.mappedValue);
  if (!color) return null;

  const level = Math.min(elevation, ELEVATION_LEVELS - 1);
  return elevationBackgroundHex(theme, level) === toHex(color) ? level : null;
}

// The positional depth block (Amendment 3.7): level N is N nested
// `:is(<sorted islands>)` hops, each rule painting background, shadow, and
// the inherited surface variable for its rung. Emitted BEFORE the
// per-signature groups, ascending so a deeper rule wins at equal (zero,
// via the shared :where() gate wrap) specificity; nesting past level 3
// keeps matching the level-3 rule — the natural cap. Empty island set
// emits nothing, byte-stable with a no-island page.
function buildPositionalGroups(islandSelectors: ReadonlySet<string>): StyleRule[] {
  if (islandSelectors.size === 0) return [];

  const islandList = `:is(${[...islandSelectors].sort(compareStrings).join(', ')})`;
  const groups: StyleRule[] = [];

  for (let level = 1; level < ELEVATION_LEVELS; level += 1) {
    groups.push({
      conditions: [],
      selector: Array.from({ length: level }, () => islandList).join(' '),
      declarations: new Map([
        [CURRENT_SURFACE_VARIABLE, `var(${elevationVariable(level)})`],
        ['background-color', `var(${elevationVariable(level)})`],
        ['box-shadow', `var(${shadowVariable(level)})`],
      ]),
    });
  }

  return groups;
}

// Superset-bleed neutralizer (Codex P1, PR #21): island selectors do not
// enforce an exact class set — island `div.card` also matches
// `<div class="card flat">`, whose own signature is surface-following. The
// follower's later background rule wins the background, but the positional
// rule's OTHER declarations stay in force on that element: its locally-set
// surface variable and island shadow — a phantom island hop. For every
// follower whose leaf class set is a STRICT superset of an emitted
// island's (same leaf tag), one group between the positional block and the
// per-signature groups undoes both: `inherit` on a custom property
// explicitly restores the parent's value (at ground level it resolves to
// the guaranteed-invalid initial, so the follower's own fallback still
// lands the ground rung), and `box-shadow: none` is the follower's sampled
// reality by definition — a qualifying shadow would have classified it
// island. Bleed-free pages emit zero extra bytes; groups sort by follower
// selector for deterministic output.
function buildBleedResets(
  islands: ReadonlyMap<string, string>,
  followers: ReadonlyMap<string, string>,
): StyleRule[] {
  const selectors: string[] = [];

  for (const [followerSignature, followerSelector] of followers) {
    const bleeds = [...islands.keys()].some((islandSignature) =>
      isLeafClassSuperset(followerSignature, islandSignature),
    );
    if (bleeds) selectors.push(followerSelector);
  }

  return selectors.toSorted(compareStrings).map((selector) => ({
    conditions: [],
    selector,
    declarations: new Map([
      [CURRENT_SURFACE_VARIABLE, 'inherit'],
      ['box-shadow', 'none'],
    ]),
  }));
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

// guardContrast (contrastGuard.ts) supplies a global text default, but each
// sampled surface still needs a local foreground. Existing text entries
// are repaired against their own mapped/preserved background; a surface
// whose text was removed by the authoredRemap stop-list receives a synthetic
// text entry so inherited descendants resolve against that surface instead
// of an unrelated outer control. Border declarations are untouched. Pure:
// returns a new array, never mutates `resolved`.
function guardSurfaceText(
  resolved: readonly ResolvedNovelDeclaration[],
  declarations: readonly NovelDeclaration[],
  backgroundBySelector: ReadonlyMap<string, string>,
  theme: PaletteTheme,
): ResolvedNovelDeclaration[] {
  const textSelectors = new Set<string>();
  const surfaces = new Map<string, NovelDeclaration>();
  for (const declaration of declarations) {
    if (declaration.bucket === 'text') textSelectors.add(declaration.selector);
    if (declaration.bucket === 'background') surfaces.set(declaration.selector, declaration);
  }

  const guarded = resolved.map((entry) => {
    if (entry.declaration.bucket !== 'text') return entry;
    const mappedBackground = backgroundBySelector.get(entry.declaration.selector);
    if (mappedBackground === undefined) return entry;

    const override = pairedTextOverride(entry.mappedValue, mappedBackground, theme);
    return override === null ? entry : { ...entry, mappedValue: override };
  });

  const defaultText = themeTokenHex(theme, 'text');
  const defaultTextColor = parseCssColor(defaultText);
  if (!defaultTextColor) throw new Error(`invalid theme text token color: ${defaultText}`);

  for (const [selector, surface] of surfaces) {
    if (textSelectors.has(selector)) continue;
    const mappedBackground = backgroundBySelector.get(selector);
    if (mappedBackground === undefined) continue;
    const mappedValue = pairedTextOverride(defaultText, mappedBackground, theme) ?? defaultText;

    guarded.push({
      declaration: {
        signature: surface.signature,
        selector,
        property: 'color',
        value: defaultText,
        color: defaultTextColor,
        bucket: 'text',
        conditions: surface.conditions,
      },
      mappedValue,
      isSelectorHint: false,
    });
  }

  return guarded;
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
