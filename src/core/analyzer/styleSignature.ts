// src/core/analyzer/styleSignature.ts
const KEY_SEPARATOR = '|';
const REFINEMENT_SEPARATOR = ' > ';

// Raw signature: lowercase tag + sorted, deduplicated classes. `classList`
// (not `className`) so SVG elements — whose className is an
// SVGAnimatedString — key identically to HTML ones.
export function computeSignature(element: Element): string {
  const classes = [...new Set(Array.from(element.classList))].sort(compareOrdinal);
  return [element.tagName.toLowerCase(), ...classes].join(KEY_SEPARATOR);
}

// Explicit binary comparator (not `localeCompare`) keeps the sort order
// locale-independent — determinism across machines. Guard clauses instead
// of a nested ternary to satisfy sonarjs/no-nested-conditional.
function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// Depth-1 context refinement: the immediate Element parent's key prefixes
// the element's own. Root-level elements have no Element parent and keep
// their own key — refinement is a no-op there by construction.
export function computeRefinedSignature(element: Element): string {
  const parent = element.parentElement;
  if (!parent) return computeSignature(element);
  return `${computeSignature(parent)}${REFINEMENT_SEPARATOR}${computeSignature(element)}`;
}

export function signatureToSelector(signature: string): string {
  return signature.split(REFINEMENT_SEPARATOR).map(partToSelector).join(REFINEMENT_SEPARATOR);
}

function partToSelector(part: string): string {
  const [tag, ...classes] = part.split(KEY_SEPARATOR);
  return [tag, ...classes.map(escapeClass)].join('.');
}

// CSS.escape exists in every target browser; happy-dom lacks it, so tests
// exercise the fallback. Escapes every character a Tailwind-style class can
// smuggle into a selector (colons, slashes, brackets).
function escapeClass(className: string): string {
  const cssEscape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  if (cssEscape) return cssEscape(className);
  return className.replaceAll(/[^\w-]/g, (character) => `\\${character}`);
}
