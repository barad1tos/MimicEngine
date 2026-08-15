import { compareStrings } from '../sort';

const GATE = 'html[data-pm-active="true"]';

// Matches a leading `html` or `:root` token at a real boundary — the next
// character (if any) is neither a word character nor a hyphen, so `html.dark`
// and `:root` match but `html-tag-name` does not. Case-insensitive: authored
// selectors can spell either token in any case (`HTML.dark`, `:ROOT`).
const HTML_ROOT_TOKEN = /^(html|:root)(?![\w-])/i;

// Override-wins cascade contract: every strategy-emitted site selector is
// wrapped in `:where(...)`, which contributes zero specificity. A strategy
// rule's specificity is therefore always exactly the gate's, regardless of
// how complex the site selector is — so a SiteOverride rule (composeStylesheet
// always emits those last, unwrapped, at full specificity) beats it on
// specificity alone, and ties break in the override's favor by source order.
// A selector already rooted at `html`/`:root` gets the gate GRAFTED onto that
// token rather than prefixed as a descendant combinator (`html.dark .x` stays
// one compound selector graft, not `html[...] html.dark .x`), and the entire
// remainder after the graft point goes inside :where(...) — same zero-
// specificity guarantee as the non-grafted case, just composed at the graft
// site: `html[data-pm-active="true"]:where(.dark .x)`. Bare `html`/`:root`
// (empty remainder) collapses onto the gate alone — `:where()` with no
// argument is invalid CSS, so there is nothing to wrap.
function scopeSelector(selector: string): string {
  const match = HTML_ROOT_TOKEN.exec(selector);
  if (!match) return `${GATE} :where(${selector})`;

  const remainder = selector.slice(match[0].length);
  return remainder.length === 0 ? GATE : `${GATE}:where(${remainder})`;
}

function emitSelectorBlock(selector: string, declarations: Map<string, string>): string {
  const lines = Array.from(declarations.entries())
    .sort(([propertyA], [propertyB]) => compareStrings(propertyA, propertyB))
    .map(([property, value]) => `  ${property}: ${value} !important;`)
    .join('\n');

  return `${scopeSelector(selector)} {\n${lines}\n}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// Wraps a selector block in its condition chain, outermost first:
// `['@media (min-width: 600px)']` produces `@media (min-width: 600px) { <block> }`.
// Multiple simultaneous conditions nest in the same outermost-first order the
// conditions array was collected in (pageFacts' recursion order). Empty
// conditions is a no-op — the block is returned unwrapped.
function wrapInConditions(block: string, conditions: readonly string[]): string {
  return conditions.reduceRight(
    (wrapped, condition) => `${condition} {\n${indent(wrapped)}\n}`,
    block,
  );
}

export type SelectorGroup = {
  conditions: readonly string[];
  selector: string;
  declarations: Map<string, string>;
};

type GroupableDeclaration = {
  selector: string;
  property: string;
  conditions: readonly string[];
};

type ResolvedDeclaration<T extends GroupableDeclaration> = {
  declaration: T;
  mappedValue: string;
  // True for declarations whose `selector` is a fabricated approximation
  // (buildSelectorHint output: inline-style elements, computedFallback
  // samples) rather than a real, authored CSS selector. Ambiguity is only
  // tracked for these — see groupSelectors' doc comment.
  isSelectorHint: boolean;
};

function groupKeyOf(declaration: GroupableDeclaration): string {
  return `${JSON.stringify(declaration.conditions)}|${declaration.selector}`;
}

// Shared by authoredRemap and computedFallback: groups already-mapped
// declarations by (conditions, selector), in first-appearance order.
//
// Two different merge policies apply, selected per-declaration by
// `isSelectorHint`:
// - Real authored selectors (isSelectorHint: false) use ordinary CSS cascade
//   semantics — a later declaration for the same selector+property legitimately
//   overrides an earlier one, so the last value wins.
// - Selector-hint declarations (isSelectorHint: true) can collide by
//   coincidence: buildSelectorHint approximates a selector from an element's
//   id/tag/classes, so two genuinely different elements can produce the same
//   hint. When the SAME (conditions, selector, property) receives DIFFERENT
//   mapped values across hint-tracked declarations, the ambiguity is
//   unresolvable — the property is dropped from that group entirely rather
//   than guessing a winner. The same value repeated is not ambiguous and
//   collapses to one declaration as usual.
export function groupSelectors<T extends GroupableDeclaration>(
  declarations: readonly ResolvedDeclaration<T>[],
): SelectorGroup[] {
  const groups = new Map<string, SelectorGroup>();
  const hintValuesSeen = new Map<string, Set<string>>();

  for (const { declaration, mappedValue, isSelectorHint } of declarations) {
    const groupKey = groupKeyOf(declaration);
    const group = groups.get(groupKey) ?? {
      conditions: declaration.conditions,
      selector: declaration.selector,
      declarations: new Map<string, string>(),
    };
    groups.set(groupKey, group);

    if (isSelectorHint) {
      const ambiguityKey = `${groupKey}|${declaration.property}`;
      const values = hintValuesSeen.get(ambiguityKey) ?? new Set<string>();
      values.add(mappedValue);
      hintValuesSeen.set(ambiguityKey, values);

      if (values.size > 1) {
        group.declarations.delete(declaration.property);
        continue;
      }
    }

    group.declarations.set(declaration.property, mappedValue);
  }

  // A group that lost its only property to the ambiguity guard above would
  // otherwise emit an empty `{ }` rule block; drop it instead.
  return [...groups.values()].filter((group) => group.declarations.size > 0);
}

// Emits one block per group, in the caller's first-appearance order,
// declarations within a block sorted by property name (codepoint order),
// each block wrapped in its condition chain. Empty input -> ''.
export function emitGroupedRules(groups: readonly SelectorGroup[]): string {
  if (groups.length === 0) return '';

  return groups
    .map(({ conditions, selector, declarations }) =>
      wrapInConditions(emitSelectorBlock(selector, declarations), conditions),
    )
    .join('\n\n');
}
