import {
  collectComputedColors,
  type ComputedColorSample,
} from '../../analyzer/collectComputedColors';
import { isOpaque, parseCssColor, toHex } from '../../color/parseColor';
import { withStylesheetDisabled } from '../../injector/styleElement';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { emitGroupedRules } from './emitGroupedRules';

const MAX_SAMPLED_ELEMENTS = 600;

// A sample only ever becomes a declaration once its value has parsed to a
// color (see toNovelDeclarations), so `color` is narrowed non-null here —
// same idiom variableRemap.ts uses for its own colored-property subtype.
type NovelDeclaration = AuthoredColorDeclaration & {
  color: NonNullable<AuthoredColorDeclaration['color']>;
};

const SAMPLE_PROPERTY_TO_CSS: Record<ComputedColorSample['property'], string> = {
  color: 'color',
  backgroundColor: 'background-color',
  borderTopColor: 'border-top-color',
};

const SAMPLE_PROPERTY_TO_BUCKET: Record<
  ComputedColorSample['property'],
  AuthoredColorDeclaration['bucket']
> = {
  color: 'text',
  backgroundColor: 'background',
  borderTopColor: 'border',
};

// The one strategy that reads the live DOM at produce time (documented,
// spec-sanctioned impurity): everything else in this engine works off the
// pre-collected PageFacts snapshot. It samples getComputedStyle with our own
// injected stylesheet disabled, so the samples reflect the page's genuine
// styling, then keeps only colors invisible to the authored-CSS analysis
// (e.g. computed from JS-driven inline styles, canvas-drawn text, or other
// sources collectPageFacts can't see) — covering sites where authoredRemap
// and variableRemap alone leave gaps.
export const computedFallback: PaletteEngine = {
  id: 'computedFallback',
  label: 'Computed fallback',
  produceCss(theme, siteSettings, facts) {
    const samples = withStylesheetDisabled(() =>
      collectComputedColors(document, { maxElements: MAX_SAMPLED_ELEMENTS }),
    );

    const authoredHexes = collectAuthoredHexes(facts);
    const novelDeclarations = toNovelDeclarations(samples, authoredHexes);
    const syntheticFacts = buildSyntheticFacts(novelDeclarations);

    const palette = extractSitePalette(syntheticFacts);
    const mapping = buildColorMapping(palette, theme, {
      preserveBrandColors: siteSettings.preserveBrandColors,
    });
    const { mapping: guardedMapping } = guardContrast(mapping, palette, theme);

    const groups = buildSelectorGroups(novelDeclarations, guardedMapping);
    return emitGroupedRules(groups);
  },
};

function collectAuthoredHexes(facts: PageFacts): Set<string> {
  const hexes = new Set<string>();

  for (const declaration of [...facts.authoredRules, ...facts.inlineStyleColors]) {
    if (declaration.color) hexes.add(toHex(declaration.color));
  }
  for (const property of facts.customProperties) {
    if (property.color) hexes.add(toHex(property.color));
  }

  return hexes;
}

// Parses each sample, drops unparseable values, then drops every sample
// whose hex is already covered by the authored-CSS analysis — what's left is
// "novel": present in computed style but invisible to collectPageFacts.
// Translucent samples (e.g. a computed `color: rgba(0,0,0,0.5)`) are dropped
// too: toHex discards alpha, so keeping them would let a translucent sample
// dedupe against — and later be remapped through — an unrelated opaque
// occurrence of the same RGB.
function toNovelDeclarations(
  samples: readonly ComputedColorSample[],
  authoredHexes: ReadonlySet<string>,
): NovelDeclaration[] {
  const declarations: NovelDeclaration[] = [];

  for (const sample of samples) {
    const color = parseCssColor(sample.value);
    if (!color) continue;
    if (!isOpaque(color)) continue;
    if (authoredHexes.has(toHex(color))) continue;

    declarations.push({
      selector: sample.selectorHint,
      property: SAMPLE_PROPERTY_TO_CSS[sample.property],
      value: sample.value,
      color,
      bucket: SAMPLE_PROPERTY_TO_BUCKET[sample.property],
    });
  }

  return declarations;
}

// extractSitePalette expects a PageFacts-shaped bag of authored declarations;
// the novel samples are synthesized into that shape so the same palette
// extraction, color mapping, and contrast guard authoredRemap uses apply here
// unchanged — no parallel palette-building logic to keep in sync.
function buildSyntheticFacts(authoredRules: NovelDeclaration[]): PageFacts {
  return {
    customProperties: [],
    authoredRules,
    inlineStyleColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    styleSheetCount: 0,
    unreadableStyleSheetCount: 0,
  };
}

// Groups by selector in first-appearance order (document order, inherited
// from the TreeWalker collectComputedColors used to sample); a repeated
// selector+property keeps the last value seen, same cascade semantics as
// authoredRemap's grouping.
function buildSelectorGroups(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();

  for (const declaration of declarations) {
    const mappedValue = mapping.get(toHex(declaration.color));
    if (mappedValue === undefined) continue;

    const group = groups.get(declaration.selector) ?? new Map<string, string>();
    group.set(declaration.property, mappedValue);
    groups.set(declaration.selector, group);
  }

  return groups;
}
