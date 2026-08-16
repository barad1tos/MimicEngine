import { parseCssColor, type RgbaColor } from '../color/parseColor';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';
import { buildSelectorHint } from './selectorHint';
import { compareStrings } from './sort';

export type CustomPropertyFact = {
  name: string;
  value: string;
  color: RgbaColor | null;
  usage: { background: number; text: number; border: number; other: number };
};

export type AuthoredColorDeclaration = {
  selector: string;
  property: string; // as authored, e.g. 'background-color'
  value: string; // authored literal
  color: RgbaColor | null;
  bucket: keyof CustomPropertyFact['usage'];
  // The @media/@supports chain this declaration is nested inside, outermost
  // first (e.g. ['@media (min-width: 600px)']); empty for a top-level rule.
  conditions: string[];
};

export type PageFacts = {
  customProperties: CustomPropertyFact[];
  authoredRules: AuthoredColorDeclaration[]; // readable sheets only, budget-capped, document order
  inlineStyleColors: AuthoredColorDeclaration[]; // from [style] attributes, capped element walk
  domElementCount: number;
  shadowRootCount: number;
  stylesheetCount: number;
  unreadableStylesheetCount: number;
};

export type CollectPageFactsOptions = {
  maxRules: number;
  maxCustomProperties: number;
  maxElements: number;
  maxAuthoredDeclarations: number;
};

const DEFAULT_OPTIONS: CollectPageFactsOptions = {
  maxRules: 5000,
  maxCustomProperties: 200,
  maxElements: 1500,
  maxAuthoredDeclarations: 1000,
};

type RuleWalkBudgets = Pick<CollectPageFactsOptions, 'maxRules' | 'maxAuthoredDeclarations'>;

type RuleWalkState = {
  declarations: Map<string, string>;
  usage: Map<string, CustomPropertyFact['usage']>;
  authoredRules: AuthoredColorDeclaration[];
  rulesVisited: number;
  budgets: RuleWalkBudgets;
};

export function collectPageFacts(
  doc: Document,
  options: Partial<CollectPageFactsOptions> = {},
): PageFacts {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const ownStyleSheet = getOwnStyleSheet(doc);
  const sheets = Array.from(doc.styleSheets).filter((sheet) => sheet !== ownStyleSheet);
  const { declarations, usage, authoredRules, stylesheetCount, unreadableStylesheetCount } =
    collectFromSheets(sheets, {
      maxRules: resolved.maxRules,
      maxAuthoredDeclarations: resolved.maxAuthoredDeclarations,
    });
  collectInlineRootDeclarations(doc, declarations);

  const customProperties = buildCustomProperties(declarations, usage, resolved.maxCustomProperties);
  // maxAuthoredDeclarations is one shared budget across authoredRules and
  // inlineStyleColors: the sheet walk (document order) consumes it first,
  // the DOM inline-style walk gets whatever remains.
  const remainingAuthoredBudget = Math.max(
    0,
    resolved.maxAuthoredDeclarations - authoredRules.length,
  );
  const { domElementCount, shadowRootCount, inlineStyleColors } = walkDom(
    doc,
    resolved.maxElements,
    remainingAuthoredBudget,
  );

  return {
    customProperties,
    authoredRules,
    inlineStyleColors,
    domElementCount,
    shadowRootCount,
    stylesheetCount,
    unreadableStylesheetCount,
  };
}

function getOwnStyleSheet(doc: Document): CSSStyleSheet | null {
  const ownElement = doc.getElementById(STYLE_ELEMENT_ID);
  return ownElement instanceof HTMLStyleElement ? ownElement.sheet : null;
}

/**
 * Walks the given stylesheets and their rules (recursing into `@media`/`@supports`
 * grouping rules) to collect custom-property declarations, custom-property usage,
 * and authored color declarations. Exposed standalone so the unreadable-sheet path
 * can be exercised with a stub sheet, independent of a real `Document`.
 */
export function collectFromSheets(
  sheets: CSSStyleSheet[],
  budgets: RuleWalkBudgets,
): {
  declarations: Map<string, string>;
  usage: Map<string, CustomPropertyFact['usage']>;
  authoredRules: AuthoredColorDeclaration[];
  stylesheetCount: number;
  unreadableStylesheetCount: number;
} {
  const state: RuleWalkState = {
    declarations: new Map(),
    usage: new Map(),
    authoredRules: [],
    rulesVisited: 0,
    budgets,
  };
  let stylesheetCount = 0;
  let unreadableStylesheetCount = 0;

  for (const sheet of sheets) {
    stylesheetCount += 1;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadableStylesheetCount += 1;
      continue;
    }
    visitRuleList(rules, state, []);
  }

  return {
    declarations: state.declarations,
    usage: state.usage,
    authoredRules: state.authoredRules,
    stylesheetCount,
    unreadableStylesheetCount,
  };
}

function visitRuleList(
  rules: CSSRuleList,
  state: RuleWalkState,
  conditions: readonly string[],
): void {
  for (const rule of Array.from(rules)) {
    if (state.rulesVisited >= state.budgets.maxRules) return;
    state.rulesVisited += 1;
    visitRule(rule, state, conditions);
  }
}

function visitRule(rule: CSSRule, state: RuleWalkState, conditions: readonly string[]): void {
  if (rule instanceof CSSStyleRule) {
    collectDeclarations(rule, state.declarations);
    collectUsage(rule, state.usage);
    collectRuleColors(rule, state, conditions);
    return;
  }
  // Authored analysis is source-based: it does not evaluate whether a media
  // condition currently matches. Every nested rule inside a grouping rule
  // (@media, @supports, ...) is visited unconditionally — only the condition
  // chain attached to its declarations records that it was conditional.
  if (rule instanceof CSSMediaRule) {
    visitRuleList(rule.cssRules, state, [...conditions, `@media ${rule.media.mediaText}`]);
    return;
  }
  if (rule instanceof CSSSupportsRule) {
    visitRuleList(rule.cssRules, state, [...conditions, `@supports ${rule.conditionText}`]);
    return;
  }
  if (rule instanceof CSSGroupingRule) {
    visitRuleList(rule.cssRules, state, conditions);
  }
}

function collectDeclarations(rule: CSSStyleRule, declarations: Map<string, string>): void {
  if (!isRootSelector(rule.selectorText)) return;
  for (const property of Array.from(rule.style)) {
    if (!property.startsWith('--')) continue;
    declarations.set(property, rule.style.getPropertyValue(property).trim());
  }
}

type SelectorSplitState = {
  depth: number;
  quote: '"' | "'" | null;
  escaped: boolean;
  current: string;
};

// Splits only on top-level commas: a comma nested inside `()`/`[]` (e.g.
// `:is(.a, .b)`, `[title="a,b"]`) or inside a quoted string belongs to that
// sub-expression, not the selector list. Depth tracks both bracket kinds
// together since CSS selectors never mismatch them; quote state suspends
// depth tracking entirely so a bracket character inside a quoted attribute
// value can't be mistaken for real nesting. A backslash escapes the very
// next character verbatim in both quote and non-quote state, so an escaped
// comma (`.a\, .b`) never splits and an escaped quote inside a string
// (`[title="a\",b"]`) never closes the string early.
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  const state: SelectorSplitState = { depth: 0, quote: null, escaped: false, current: '' };

  for (const char of selectorText) {
    if (advanceSelectorSplit(char, state)) {
      parts.push(state.current.trim());
      state.current = '';
    }
  }
  parts.push(state.current.trim());

  return parts;
}

// Mutates `state` for one selector-text character and reports whether it was
// a top-level comma (a selector-list separator the caller should split on),
// as opposed to a character consumed into the current selector.
function advanceSelectorSplit(char: string, state: SelectorSplitState): boolean {
  if (state.escaped) {
    state.current += char;
    state.escaped = false;
    return false;
  }
  if (char === '\\') {
    state.escaped = true;
    state.current += char;
    return false;
  }
  if (state.quote) {
    state.current += char;
    if (char === state.quote) state.quote = null;
    return false;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    state.current += char;
    return false;
  }
  if (char === '(' || char === '[') {
    state.depth += 1;
    state.current += char;
    return false;
  }
  if (char === ')' || char === ']') {
    state.depth = Math.max(0, state.depth - 1);
    state.current += char;
    return false;
  }
  if (char === ',' && state.depth === 0) {
    return true;
  }
  state.current += char;
  return false;
}

const ROOT_SELECTORS = new Set([':root', 'html']);

function isRootSelector(selectorText: string): boolean {
  return splitSelectorList(selectorText).some((part) => ROOT_SELECTORS.has(part));
}

// A comma-separated selector list (e.g. `.a, .b { color: red }`) is emitted
// as one AuthoredColorDeclaration per individual selector, never the raw
// list — downstream consumers interpolate `selector` directly after a scope
// prefix, and a literal comma would let later selectors escape that scope.
function collectRuleColors(
  rule: CSSStyleRule,
  state: RuleWalkState,
  conditions: readonly string[],
): void {
  const selectors = splitSelectorList(rule.selectorText);
  for (const property of Array.from(rule.style)) {
    // Custom-property declarations belong to the variableRemap path (see
    // collectDeclarations above); they consumed authoredRules budget with
    // zero consumers on that path, so they never enter authoredRules at all.
    if (property.startsWith('--')) continue;
    const value = rule.style.getPropertyValue(property).trim();
    const color = parseCssColor(value);
    if (!color) continue;
    const bucket = usageBucket(property);
    for (const selector of selectors) {
      if (state.authoredRules.length >= state.budgets.maxAuthoredDeclarations) return;
      state.authoredRules.push({
        selector,
        property,
        value,
        color,
        bucket,
        conditions: [...conditions],
      });
    }
  }
}

const USAGE_PATTERN = /var\(\s*(--[\w-]+)/gi;

function emptyUsage(): CustomPropertyFact['usage'] {
  return { background: 0, text: 0, border: 0, other: 0 };
}

function collectUsage(rule: CSSStyleRule, usage: Map<string, CustomPropertyFact['usage']>): void {
  for (const property of Array.from(rule.style)) {
    const value = rule.style.getPropertyValue(property);
    for (const match of value.matchAll(USAGE_PATTERN)) {
      const name = match[1];
      if (!name) continue;
      const bucket = usage.get(name) ?? emptyUsage();
      bucket[usageBucket(property)] += 1;
      usage.set(name, bucket);
    }
  }
}

function usageBucket(property: string): keyof CustomPropertyFact['usage'] {
  if (property.startsWith('background')) return 'background';
  if (property === 'color' || property === 'caret-color' || property === 'fill') return 'text';
  if (property.startsWith('border') || property.startsWith('outline') || property === 'stroke') {
    return 'border';
  }
  return 'other';
}

function collectInlineRootDeclarations(doc: Document, declarations: Map<string, string>): void {
  const inline = doc.documentElement.style;
  for (const property of Array.from(inline)) {
    if (property.startsWith('--')) {
      declarations.set(property, inline.getPropertyValue(property).trim());
    }
  }
}

function buildCustomProperties(
  declarations: Map<string, string>,
  usage: Map<string, CustomPropertyFact['usage']>,
  maxCustomProperties: number,
): CustomPropertyFact[] {
  return Array.from(declarations.entries())
    .filter(([, value]) => !value.includes('var('))
    .sort(([a], [b]) => compareStrings(a, b))
    .slice(0, maxCustomProperties)
    .map(([name, value]) => ({
      name,
      value,
      color: parseCssColor(value),
      usage: usage.get(name) ?? emptyUsage(),
    }));
}

function walkDom(
  doc: Document,
  maxElements: number,
  maxAuthoredDeclarations: number,
): {
  domElementCount: number;
  shadowRootCount: number;
  inlineStyleColors: AuthoredColorDeclaration[];
} {
  let domElementCount = 0;
  let shadowRootCount = 0;
  const inlineStyleColors: AuthoredColorDeclaration[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode() && domElementCount < maxElements) {
    const element = walker.currentNode;
    if (!(element instanceof Element) || element.id === STYLE_ELEMENT_ID) continue;
    domElementCount += 1;
    if (element.shadowRoot) shadowRootCount += 1;
    collectInlineStyleColors(element, inlineStyleColors, maxAuthoredDeclarations);
  }
  return { domElementCount, shadowRootCount, inlineStyleColors };
}

function collectInlineStyleColors(
  element: Element,
  target: AuthoredColorDeclaration[],
  maxAuthoredDeclarations: number,
): void {
  if (!(element instanceof HTMLElement) || element.style.length === 0) return;
  const selector = buildSelectorHint(element);
  for (const property of Array.from(element.style)) {
    // Same guard as collectRuleColors: an inline custom-property declaration
    // has no consumer either (variableRemap only reads customProperties from
    // stylesheets and the root element's own inline style).
    if (property.startsWith('--')) continue;
    if (target.length >= maxAuthoredDeclarations) return;
    const value = element.style.getPropertyValue(property).trim();
    const color = parseCssColor(value);
    if (!color) continue;
    target.push({
      selector,
      property,
      value,
      color,
      bucket: usageBucket(property),
      conditions: [],
    });
  }
}
