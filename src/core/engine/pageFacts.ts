import { parseCssColor, type RgbaColor } from '../color/parseColor';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';

export type CustomPropertyFact = {
  name: string;
  value: string;
  color: RgbaColor | null;
  usage: { background: number; text: number; border: number; other: number };
};

export type PageFacts = {
  customProperties: CustomPropertyFact[];
  domElementCount: number;
  shadowRootCount: number;
  styleSheetCount: number;
  unreadableStyleSheetCount: number;
};

export type CollectPageFactsOptions = {
  maxRules: number;
  maxCustomProperties: number;
  maxElements: number;
};

const DEFAULT_OPTIONS: CollectPageFactsOptions = {
  maxRules: 5000,
  maxCustomProperties: 200,
  maxElements: 1500,
};

export function collectPageFacts(
  doc: Document,
  options: Partial<CollectPageFactsOptions> = {},
): PageFacts {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const declarations = new Map<string, string>();
  const usage = new Map<string, CustomPropertyFact['usage']>();
  const ownStyleSheet = getOwnStyleSheet(doc);
  let rulesVisited = 0;
  let unreadableStyleSheetCount = 0;
  let styleSheetCount = 0;

  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet === ownStyleSheet) continue;
    styleSheetCount += 1;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadableStyleSheetCount += 1;
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rulesVisited >= resolved.maxRules) break;
      rulesVisited += 1;
      if (!(rule instanceof CSSStyleRule)) continue;
      collectDeclarations(rule, declarations);
      collectUsage(rule, usage);
    }
  }
  collectInlineRootDeclarations(doc, declarations);

  const customProperties = Array.from(declarations.entries())
    .filter(([, value]) => !value.includes('var('))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, resolved.maxCustomProperties)
    .map(([name, value]) => ({
      name,
      value,
      color: parseCssColor(value),
      usage: usage.get(name) ?? { background: 0, text: 0, border: 0, other: 0 },
    }));

  return {
    customProperties,
    ...countDomFacts(doc, resolved.maxElements),
    styleSheetCount,
    unreadableStyleSheetCount,
  };
}

function getOwnStyleSheet(doc: Document): CSSStyleSheet | null {
  const ownElement = doc.getElementById(STYLE_ELEMENT_ID);
  return ownElement instanceof HTMLStyleElement ? ownElement.sheet : null;
}

function collectDeclarations(rule: CSSStyleRule, declarations: Map<string, string>): void {
  const selector = rule.selectorText;
  if (selector !== ':root' && selector !== 'html' && selector !== ':root, html') return;
  for (const property of Array.from(rule.style)) {
    if (!property.startsWith('--')) continue;
    declarations.set(property, rule.style.getPropertyValue(property).trim());
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

function countDomFacts(
  doc: Document,
  maxElements: number,
): { domElementCount: number; shadowRootCount: number } {
  let domElementCount = 0;
  let shadowRootCount = 0;
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode() && domElementCount < maxElements) {
    const element = walker.currentNode;
    if (!(element instanceof Element) || element.id === STYLE_ELEMENT_ID) continue;
    domElementCount += 1;
    if (element.shadowRoot) shadowRootCount += 1;
  }
  return { domElementCount, shadowRootCount };
}
