import { isOpaque, toHex } from '../../color/parseColor';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import { computeCoverage } from '../coverage';
import type { AuthoredColorDeclaration, PageFacts, SvgPresentationColor } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { groupSelectors, type StyleRule } from '../stylePlan';

// Manual-only, last in registry order (see strategyId.ts): fill/stroke
// attribute values and inline-style declarations that survive here are the
// ones no other strategy touches — authoredRemap only reads stylesheet rules
// and computedFallback samples getComputedStyle, neither of which sees an
// HTML presentation attribute or reasons about it separately from the CSS
// cascade output. deepRemap is the escape hatch for the SVG-icon and
// inline-style-heavy sites that leaves for the other four strategies.
export const deepRemap: PaletteEngine = {
  id: 'deepRemap',
  label: 'Deep remap',
  produce(theme, siteSettings, facts) {
    const palette = extractSitePalette(svgAugmentedFacts(facts));
    const mapping = buildColorMapping(palette, theme, {
      preserveBrandColors: siteSettings.preserveBrandColors,
    });
    const { mapping: guardedMapping } = guardContrast(mapping, palette, theme);

    const svgRules = buildSvgRules(facts.svgPresentationColors, guardedMapping);
    const inlineRules = buildInlineRules(facts.inlineStyleColors, guardedMapping);
    const coverage = computeCoverage(palette, guardedMapping);

    return { content: { kind: 'rules', rules: [...svgRules, ...inlineRules] }, coverage };
  },
};

// Palette union

// Reuses extractSitePalette's own dedupe/weight/bucket/opacity logic (rather
// than reimplementing it) by feeding svg presentation colors through the
// same AuthoredColorDeclaration shape it already accumulates authoredRules
// and inlineStyleColors from — 'other' bucket, since an svg fill/stroke has
// no background/text/border authoring context of its own.
function svgColorsAsDeclarations(
  svgColors: readonly SvgPresentationColor[],
): AuthoredColorDeclaration[] {
  return svgColors.map((entry) => ({
    selector: `svg[${entry.attribute}]`,
    property: entry.attribute,
    value: entry.value,
    color: entry.color,
    bucket: 'other',
    conditions: [],
  }));
}

function svgAugmentedFacts(facts: PageFacts): PageFacts {
  return {
    ...facts,
    authoredRules: [
      ...facts.authoredRules,
      ...svgColorsAsDeclarations(facts.svgPresentationColors),
    ],
  };
}

// SVG rules

// CSS string-literal escaping for the value embedded inside the attribute
// selector's double quotes: backslash first, then the quote itself, so an
// already-escaped backslash is never double-escaped.
function escapeAttributeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
}

// `:is(svg, svg *)` rather than a bare descendant combinator: the SVG
// presentation-color collector records the fill/stroke attribute from the
// <svg> root itself too (icon libraries put it there), and `svg *` alone
// would never match the root.
//
// Padded-attribute edge: pageFacts trims the collected value, but this
// exact-match selector is built from that trimmed value against the live
// (untrimmed) DOM attribute — a fill/stroke value with surrounding
// whitespace (e.g. `fill=" #101014 "`) never matches, so the rule is
// benignly dead rather than mis-scoped. There is no safe CSS fix: `~=`
// splits on whitespace, which would also match a space-separated
// paint-server fallback list (e.g. `fill="url(#gradient) #101014"`) and
// overpaint a token that was never a literal color of its own.
function svgAttributeSelector(entry: SvgPresentationColor): string {
  return `:is(svg, svg *)[${entry.attribute}="${escapeAttributeValue(entry.value)}"]`;
}

// A translucent svg color must never resolve through a mapping entry an
// unrelated opaque occurrence of the same RGB created — toHex drops alpha,
// so the check is explicit here rather than trusted to the palette (which
// only ever contains opaque entries, but a translucent lookup key could
// still collide with one by RGB).
function mappedSvgValue(entry: SvgPresentationColor, mapping: ColorMapping): string | null {
  if (!entry.color) return null;
  if (!isOpaque(entry.color)) return null;
  return mapping.get(toHex(entry.color)) ?? null;
}

// SVG entries carry no document position of their own, so their selectors
// sort by codepoint before the page-plan emitter serializes them. Every rule
// shares the same empty condition chain and gate prefix, making selector order
// byte-identical to the former full-rule-text order.
function buildSvgRules(
  svgColors: readonly SvgPresentationColor[],
  mapping: ColorMapping,
): StyleRule[] {
  const rules: StyleRule[] = [];

  for (const entry of svgColors) {
    const mappedValue = mappedSvgValue(entry, mapping);
    if (mappedValue === null) continue;

    const rule: StyleRule = {
      conditions: [],
      selector: svgAttributeSelector(entry),
      declarations: new Map([[entry.attribute, mappedValue]]),
    };
    rules.push(rule);
  }

  return rules.toSorted((first, second) => compareStrings(first.selector, second.selector));
}

// Inline-style rules

// Mirrors authoredRemap's mappedValueFor: a translucent declaration must
// never resolve through an opaque mapping entry that shares its RGB, and a
// custom-property declaration has no consumer on this path.
function mappedInlineValue(
  declaration: AuthoredColorDeclaration,
  mapping: ColorMapping,
): string | null {
  if (declaration.color === null) return null;
  if (declaration.property.startsWith('--')) return null;
  if (!isOpaque(declaration.color)) return null;
  return mapping.get(toHex(declaration.color)) ?? null;
}

// Same hinted-rule emission pattern computedFallback uses: inlineStyleColors
// carry buildSelectorHint approximations rather than real CSS selectors, so
// they're ambiguity-tracked by groupSelectors (isSelectorHint: true).
function buildInlineRules(
  inlineStyleColors: readonly AuthoredColorDeclaration[],
  mapping: ColorMapping,
): StyleRule[] {
  const resolved: {
    declaration: AuthoredColorDeclaration;
    mappedValue: string;
    isSelectorHint: true;
  }[] = [];

  for (const declaration of inlineStyleColors) {
    const mappedValue = mappedInlineValue(declaration, mapping);
    if (mappedValue !== null) resolved.push({ declaration, mappedValue, isSelectorHint: true });
  }

  return groupSelectors(resolved);
}
