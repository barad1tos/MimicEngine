import { compareStrings } from '../sort';

const GATE = 'html[data-pm-active="true"]';

// Matches a leading `html` or `:root` token at a real boundary — the next
// character (if any) is neither a word character nor a hyphen, so `html.dark`
// and `:root` match but `html-tag-name` does not.
const HTML_ROOT_TOKEN = /^(html|:root)(?![\w-])/;

// A selector already rooted at `html`/`:root` must have the gate GRAFTED onto
// that token rather than prefixed as a descendant combinator: `html.dark .x`
// stays a single compound selector (`html[data-pm-active="true"].dark .x`),
// and bare `html`/`:root` collapse onto the gate itself with no trailing
// space. Any other selector keeps the plain descendant-combinator prefix.
function scopeSelector(selector: string): string {
  const match = HTML_ROOT_TOKEN.exec(selector);
  if (!match) return `${GATE} ${selector}`;
  return `${GATE}${selector.slice(match[0].length)}`;
}

function emitSelectorBlock(selector: string, declarations: Map<string, string>): string {
  const lines = Array.from(declarations.entries())
    .sort(([propertyA], [propertyB]) => compareStrings(propertyA, propertyB))
    .map(([property, value]) => `  ${property}: ${value} !important;`)
    .join('\n');

  return `${scopeSelector(selector)} {\n${lines}\n}`;
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
