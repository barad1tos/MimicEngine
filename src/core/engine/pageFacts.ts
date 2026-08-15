import { parseCssColor, type RgbaColor } from '../color/parseColor';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';

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
};

export type PageFacts = {
  customProperties: CustomPropertyFact[];
  authoredRules: AuthoredColorDeclaration[]; // readable sheets only, budget-capped, document order
  inlineStyleColors: AuthoredColorDeclaration[]; // from [style] attributes, capped element walk
  domElementCount: number;
  shadowRootCount: number;
  styleSheetCount: number;
  unreadableStyleSheetCount: number;
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
  const { declarations, usage, authoredRules, styleSheetCount, unreadableStyleSheetCount } =
    collectFromSheets(sheets, {
      maxRules: resolved.maxRules,
      maxAuthoredDeclarations: resolved.maxAuthoredDeclarations,
    });
  collectInlineRootDeclarations(doc, declarations);

  const customProperties = buildCustomProperties(declarations, usage, resolved.maxCustomProperties);
  const { domElementCount, shadowRootCount, inlineStyleColors } = walkDom(
    doc,
    resolved.maxElements,
    resolved.maxAuthoredDeclarations,
  );

  return {
    customProperties,
    authoredRules,
    inlineStyleColors,
    domElementCount,
    shadowRootCount,
    styleSheetCount,
    unreadableStyleSheetCount,
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
  styleSheetCount: number;
  unreadableStyleSheetCount: number;
} {
  const state: RuleWalkState = {
    declarations: new Map(),
    usage: new Map(),
    authoredRules: [],
    rulesVisited: 0,
    budgets,
  };
  let styleSheetCount = 0;
  let unreadableStyleSheetCount = 0;

  for (const sheet of sheets) {
    styleSheetCount += 1;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadableStyleSheetCount += 1;
      continue;
    }
    visitRuleList(rules, state);
  }

  return {
    declarations: state.declarations,
    usage: state.usage,
    authoredRules: state.authoredRules,
    styleSheetCount,
    unreadableStyleSheetCount,
  };
}

function visitRuleList(rules: CSSRuleList, state: RuleWalkState): void {
  for (const rule of Array.from(rules)) {
    if (state.rulesVisited >= state.budgets.maxRules) return;
    state.rulesVisited += 1;
    visitRule(rule, state);
  }
}

function visitRule(rule: CSSRule, state: RuleWalkState): void {
  if (rule instanceof CSSStyleRule) {
    collectDeclarations(rule, state.declarations);
    collectUsage(rule, state.usage);
    collectRuleColors(rule, state);
    return;
  }
  // Authored analysis is source-based: it does not evaluate whether a media
  // condition currently matches. Every nested rule inside a grouping rule
  // (@media, @supports, ...) is visited unconditionally.
  if (rule instanceof CSSGroupingRule) {
    visitRuleList(rule.cssRules, state);
  }
}

function collectDeclarations(rule: CSSStyleRule, declarations: Map<string, string>): void {
  if (!isRootSelector(rule.selectorText)) return;
  for (const property of Array.from(rule.style)) {
    if (!property.startsWith('--')) continue;
    declarations.set(property, rule.style.getPropertyValue(property).trim());
  }
}

const ROOT_SELECTORS = new Set([':root', 'html']);

function isRootSelector(selectorText: string): boolean {
  return selectorText
    .split(',')
    .map((part) => part.trim())
    .some((part) => ROOT_SELECTORS.has(part));
}

function collectRuleColors(rule: CSSStyleRule, state: RuleWalkState): void {
  const selector = rule.selectorText;
  for (const property of Array.from(rule.style)) {
    if (state.authoredRules.length >= state.budgets.maxAuthoredDeclarations) return;
    const value = rule.style.getPropertyValue(property).trim();
    const color = parseCssColor(value);
    if (!color) continue;
    state.authoredRules.push({ selector, property, value, color, bucket: usageBucket(property) });
  }
}

const USAGE_PATTERN = /var\(\s*(--[\w-]+)/gi;

function collectUsage(rule: CSSStyleRule, usage: Map<string, CustomPropertyFact['usage']>): void {
  for (const property of Array.from(rule.style)) {
    const value = rule.style.getPropertyValue(property);
    for (const match of value.matchAll(USAGE_PATTERN)) {
      const name = match[1];
      if (!name) continue;
      const bucket = usage.get(name) ?? { background: 0, text: 0, border: 0, other: 0 };
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
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, maxCustomProperties)
    .map(([name, value]) => ({
      name,
      value,
      color: parseCssColor(value),
      usage: usage.get(name) ?? { background: 0, text: 0, border: 0, other: 0 },
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
    if (target.length >= maxAuthoredDeclarations) return;
    const value = element.style.getPropertyValue(property).trim();
    const color = parseCssColor(value);
    if (!color) continue;
    target.push({ selector, property, value, color, bucket: usageBucket(property) });
  }
}

function buildSelectorHint(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const className = [...element.classList]
    .slice(0, 2)
    .map((item) => `.${CSS.escape(item)}`)
    .join('');
  return `${element.tagName.toLowerCase()}${className}`;
}
