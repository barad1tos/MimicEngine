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

// Shared by every strategy that emits selector-scoped !important declarations
// (authoredRemap, computedFallback): one block per Map entry, in the map's
// iteration order (the caller's first-appearance contract), declarations
// within a block sorted by property name, codepoint order. Empty input -> ''.
export function emitGroupedRules(groups: Map<string, Map<string, string>>): string {
  if (groups.size === 0) return '';

  return Array.from(groups.entries())
    .map(([selector, declarations]) => emitSelectorBlock(selector, declarations))
    .join('\n\n');
}
