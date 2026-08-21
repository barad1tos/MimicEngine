// src/core/analyzer/styleSignature.ts
import { compareStrings } from '../engine/sort';

const KEY_SEPARATOR = '|';
const REFINEMENT_SEPARATOR = ' > ';

// Raw signature: lowercase tag + sorted, deduplicated classes. `classList`
// (not `className`) so SVG elements — whose className is an
// SVGAnimatedString — key identically to HTML ones.
export function computeSignature(element: Element): string {
  const classes = [...new Set(Array.from(element.classList))].sort(compareStrings);
  return [element.tagName.toLowerCase(), ...classes].join(KEY_SEPARATOR);
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

// CSS.escape exists in every target browser (and in happy-dom, which our
// tests run under) — the fallback below exists for defense-in-depth in
// environments without it. It mirrors CSS.escape's own rules: a leading
// digit is escaped as a code-point hex escape (trailing space required so a
// following hex digit isn't read as part of it — e.g. `2xl:hidden` becomes
// `\32 xl\:hidden`, never the invalid `2xl\:hidden`); every other character
// a Tailwind-style class can smuggle into a selector (colons, slashes,
// brackets) gets a plain backslash escape.
function escapeClass(className: string): string {
  const cssEscape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  if (cssEscape) return cssEscape(className);
  return className.replaceAll(/(?:^\d)|[^\w-]/g, (character: string, offset: number) => {
    const isLeadingDigit = offset === 0 && /^\d$/.test(character);
    return isLeadingDigit ? `\\${character.charCodeAt(0).toString(16)} ` : `\\${character}`;
  });
}
