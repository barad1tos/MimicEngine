import { installedCensus, type CensusSnapshot } from '../../analyzer/signatureCensus';
import { isOpaque, parseCssColor, toHex, type HexColor } from '../../color/parseColor';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import { coverageFromCounts } from '../coverage';
import { planStrategies } from '../decisionTable';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { emitGroupedRules, groupSelectors, type SelectorGroup } from './emitGroupedRules';

// A census color only ever becomes a declaration once its value has parsed
// to a color (see toNovelDeclarations), so `color` is narrowed non-null here
// — same idiom variableRemap.ts uses for its own colored-property subtype.
type NovelDeclaration = AuthoredColorDeclaration & {
  color: NonNullable<AuthoredColorDeclaration['color']>;
};

// The controller (Task 5) builds and installs a live SignatureCensus before
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
    const authoredHexes = planStrategies(plan).includes('authoredRemap')
      ? collectAuthoredHexes(facts)
      : new Set<HexColor>();
    const novelDeclarations = toNovelDeclarations(snapshot, authoredHexes);
    const syntheticFacts = buildSyntheticFacts(novelDeclarations);

    const palette = extractSitePalette(syntheticFacts);
    const mapping = buildColorMapping(palette, theme, {
      preserveBrandColors: siteSettings.preserveBrandColors,
    });
    const { mapping: guardedMapping } = guardContrast(mapping, palette, theme);

    const groups = buildSelectorGroups(novelDeclarations, guardedMapping);
    const css = emitGroupedRules(groups);
    const mappedCount = palette.filter((entry) => guardedMapping.has(entry.hex)).length;
    const coverage = coverageFromCounts(snapshot.distinctColorsSeen, mappedCount);

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

// Groups by selector in first-appearance (census entry) order. Census
// selectors are exact — signatureToSelector derives them from the element's
// own tag/classes (or its refined parent-prefixed form), never a fabricated
// approximation — so the ambiguity-tracking machinery groupSelectors applies
// to hint-based declarations does not apply here.
function buildSelectorGroups(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
): SelectorGroup[] {
  const resolved: { declaration: NovelDeclaration; mappedValue: string; isSelectorHint: false }[] =
    [];

  for (const declaration of declarations) {
    const mappedValue = mapping.get(toHex(declaration.color));
    if (mappedValue !== undefined)
      resolved.push({ declaration, mappedValue, isSelectorHint: false });
  }

  return groupSelectors(resolved);
}
