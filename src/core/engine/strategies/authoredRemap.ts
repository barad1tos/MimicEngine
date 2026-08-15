import { toHex } from '../../color/parseColor';
import { buildColorMapping, extractSitePalette, type ColorMapping } from '../colorMap';
import { guardContrast } from '../contrastGuard';
import type { AuthoredColorDeclaration } from '../pageFacts';
import type { PaletteEngine } from '../registry';

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
    return groups.size === 0 ? '' : emitCss(groups);
  },
};

function mappedValueFor(
  declaration: AuthoredColorDeclaration,
  mapping: ColorMapping,
): string | null {
  if (declaration.color === null) return null;
  if (declaration.property.startsWith('--')) return null;
  return mapping.get(toHex(declaration.color)) ?? null;
}

// Groups mappable declarations by selector: one Map entry per selector, in
// first-appearance order across authoredRules then inlineStyleColors (the
// two arrays are walked as a single combined sequence, so a selector shared
// between both sources merges into the same group). Within a selector, a
// repeated property keeps the LAST value seen in that combined sequence,
// matching CSS cascade semantics where a later authored declaration wins.
function buildSelectorGroups(
  authoredRules: readonly AuthoredColorDeclaration[],
  inlineStyleColors: readonly AuthoredColorDeclaration[],
  mapping: ColorMapping,
): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();

  for (const declaration of [...authoredRules, ...inlineStyleColors]) {
    const mappedValue = mappedValueFor(declaration, mapping);
    if (mappedValue === null) continue;

    const group = groups.get(declaration.selector) ?? new Map<string, string>();
    group.set(declaration.property, mappedValue);
    groups.set(declaration.selector, group);
  }

  return groups;
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function emitSelectorBlock(selector: string, declarations: Map<string, string>): string {
  const lines = Array.from(declarations.entries())
    .sort(([propertyA], [propertyB]) => compareCodepoint(propertyA, propertyB))
    .map(([property, value]) => `  ${property}: ${value} !important;`)
    .join('\n');

  return `html[data-pm-active="true"] ${selector} {\n${lines}\n}`;
}

function emitCss(groups: Map<string, Map<string, string>>): string {
  return Array.from(groups.entries())
    .map(([selector, declarations]) => emitSelectorBlock(selector, declarations))
    .join('\n\n');
}
