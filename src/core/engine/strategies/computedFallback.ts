import {
  collectComputedColors,
  type ComputedColorSample,
} from '../../analyzer/collectComputedColors';
import { isOpaque, parseCssColor, toHex, type HexColor } from '../../color/parseColor';
import { withStylesheetDisabled } from '../../injector/styleElement';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import { planStrategies } from '../decisionTable';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { emitGroupedRules, groupSelectors, type SelectorGroup } from './emitGroupedRules';

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
  produceCss(theme, siteSettings, facts, plan) {
    const samples = withStylesheetDisabled(() =>
      collectComputedColors(document, { maxElements: MAX_SAMPLED_ELEMENTS }),
    );

    // The stoplist only makes sense when authoredRemap is also running on
    // this plan: it exists to keep the two strategies from double-emitting
    // the same color, not to suppress computedFallback's own coverage. A
    // plan without authoredRemap (e.g. an opaque page where computedFallback
    // is the only strategy that can see the page's colors at all) must
    // remap every opaque color it finds, authored-visible or not.
    const authoredHexes = planStrategies(plan).includes('authoredRemap')
      ? collectAuthoredHexes(facts)
      : new Set<HexColor>();
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

// Parses each sample, drops unparseable values, then drops every sample
// whose hex is already covered by the authored-CSS analysis — what's left is
// "novel": present in computed style but invisible to collectPageFacts.
// Translucent samples (e.g. a computed `color: rgba(0,0,0,0.5)`) are dropped
// too: toHex discards alpha, so keeping them would let a translucent sample
// dedupe against — and later be remapped through — an unrelated opaque
// occurrence of the same RGB.
function toNovelDeclarations(
  samples: readonly ComputedColorSample[],
  authoredHexes: ReadonlySet<HexColor>,
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
      // Samples never carry @media/@supports context — getComputedStyle
      // already resolves the current cascade, so there is no condition
      // chain left to preserve.
      conditions: [],
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
    stylesheetCount: 0,
    unreadableStylesheetCount: 0,
  };
}

// Groups by selector in first-appearance order (document order, inherited
// from the TreeWalker collectComputedColors used to sample). Every
// declaration here carries a fabricated selectorHint rather than a real CSS
// selector, so all of them are ambiguity-tracked — see groupSelectors' doc
// comment: two different elements sharing one hint but sampling different
// colors for the same property must not silently pick a winner.
function buildSelectorGroups(
  declarations: readonly NovelDeclaration[],
  mapping: ColorMapping,
): SelectorGroup[] {
  const resolved: { declaration: NovelDeclaration; mappedValue: string; isSelectorHint: true }[] =
    [];

  for (const declaration of declarations) {
    const mappedValue = mapping.get(toHex(declaration.color));
    if (mappedValue !== undefined)
      resolved.push({ declaration, mappedValue, isSelectorHint: true });
  }

  return groupSelectors(resolved);
}
