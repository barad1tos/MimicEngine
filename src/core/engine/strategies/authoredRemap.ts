import { isOpaque, toHex } from '../../color/parseColor';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import type { AuthoredColorDeclaration } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { emitGroupedRules, groupSelectors, type SelectorGroup } from './emitGroupedRules';

export const authoredRemap: PaletteEngine = {
  id: 'authoredRemap',
  label: 'Site CSS rewrite',
  produceCss(theme, siteSettings, facts) {
    const palette = extractSitePalette(facts);
    const mapping = buildColorMapping(palette, theme, {
      preserveBrandColors: siteSettings.preserveBrandColors,
    });
    const { mapping: guardedMapping } = guardContrast(mapping, palette, theme);

    const groups = buildSelectorGroups(
      facts.authoredRules,
      facts.inlineStyleColors,
      guardedMapping,
    );
    return emitGroupedRules(groups);
  },
};

function mappedValueFor(
  declaration: AuthoredColorDeclaration,
  mapping: ColorMapping,
): string | null {
  if (declaration.color === null) return null;
  if (declaration.property.startsWith('--')) return null;
  // A translucent declaration must never resolve through a mapping entry
  // that an opaque occurrence of the same RGB created — that would discard
  // the alpha and turn e.g. a 50% modal scrim opaque.
  if (!isOpaque(declaration.color)) return null;
  return mapping.get(toHex(declaration.color)) ?? null;
}

// Groups mappable declarations by (conditions, selector), in first-appearance
// order across authoredRules then inlineStyleColors (the two arrays are
// walked as a single combined sequence, so a selector shared between both
// sources under the same condition chain merges into the same group).
// authoredRules carry real, authored selectors — repeated
// (conditions, selector, property) keeps the LAST value seen, ordinary CSS
// cascade semantics. inlineStyleColors carry buildSelectorHint approximations
// instead of real selectors, so they're ambiguity-tracked: see groupSelectors'
// doc comment for why a hint collision drops the property rather than
// guessing a winner.
function buildSelectorGroups(
  authoredRules: readonly AuthoredColorDeclaration[],
  inlineStyleColors: readonly AuthoredColorDeclaration[],
  mapping: ColorMapping,
): SelectorGroup[] {
  const resolved: {
    declaration: AuthoredColorDeclaration;
    mappedValue: string;
    isSelectorHint: boolean;
  }[] = [];

  for (const declaration of authoredRules) {
    const mappedValue = mappedValueFor(declaration, mapping);
    if (mappedValue !== null) resolved.push({ declaration, mappedValue, isSelectorHint: false });
  }
  for (const declaration of inlineStyleColors) {
    const mappedValue = mappedValueFor(declaration, mapping);
    if (mappedValue !== null) resolved.push({ declaration, mappedValue, isSelectorHint: true });
  }

  return groupSelectors(resolved);
}
