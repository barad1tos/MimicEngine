// src/core/analyzer/styleSignature.ts
import { compareStrings } from '../engine/sort';

const KEY_SEPARATOR = '|';
const REFINEMENT_SEPARATOR = ' > ';

// Raw signature: lowercase tag + sorted, deduplicated classes. `classList`
// (not `className`) so SVG elements — whose className is an
// SVGAnimatedString — key identically to HTML ones.
export function computeSignature(element: Element): string {
  const classes = [...new Set(Array.from(element.classList))].sort(compareStrings);
  return [element.tagName.toLowerCase(), ...classes.map(escapeKeyToken)].join(KEY_SEPARATOR);
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
  const [tag, ...classes] = splitKeyParts(part);
  return [tag, ...classes.map(escapeClass)].join('.');
}

// `|` is a legal class-name character (`class="foo|bar"` is one class token,
// not two), so a raw class containing it must not alias with the
// KEY_SEPARATOR that joins tag/classes together — without escaping,
// `class="foo|bar"` and `class="foo bar"` key identically, and
// signatureToSelector decodes the pipe class as two compound class
// selectors that never match the sampled element. Backslash-escape first so
// an already-escaped separator round-trips unambiguously.
function escapeKeyToken(token: string): string {
  return token.replaceAll('\\', '\\\\').replaceAll(KEY_SEPARATOR, `\\${KEY_SEPARATOR}`);
}

// Reverses escapeKeyToken while splitting on KEY_SEPARATOR: an escaped
// character (`\\` or `\|`) is unescaped and kept inside the current token
// rather than treated as a split point, so this single pass both splits and
// unescapes in one another's terms — one loop, no double-processing.
function splitKeyParts(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let index = 0;

  while (index < value.length) {
    const character = value.charAt(index);
    if (character === '\\' && index + 1 < value.length) {
      current += value.charAt(index + 1);
      index += 2;
      continue;
    }
    if (character === KEY_SEPARATOR) {
      tokens.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }

  tokens.push(current);
  return tokens;
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
  return className.replaceAll(/(?:^\d)|(?:[^\w-])/g, (character: string, offset: number) => {
    const isLeadingDigit = offset === 0 && /^\d$/.test(character);
    if (!isLeadingDigit) return `\\${character}`;

    // A regex-matched leading digit is always a single BMP code point, so
    // this can never actually be undefined — the guard exists only to
    // satisfy strict TS without a non-null assertion.
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error(`escapeClass: no code point for matched character '${character}'`);
    }
    return `\\${codePoint.toString(16)} `;
  });
}
