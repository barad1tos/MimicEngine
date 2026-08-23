import type { CoverageReport } from './coverage';
import { compareStrings } from './sort';

const GATE = 'html[data-pm-active="true"]';
const HTML_ROOT_TOKEN = /^(html|:root)(?![\w-])/i;

export type StyleRule = {
  conditions: readonly string[];
  selector: string;
  declarations: ReadonlyMap<string, string>;
};

export type StyleContent =
  { kind: 'block'; css: string } | { kind: 'rules'; rules: readonly StyleRule[] };

export type StyleSection = {
  content: StyleContent;
  coverage?: CoverageReport;
};

export type StylePlan = {
  sections: readonly StyleSection[];
};

export function emitStylePlan(plan: StylePlan): {
  css: string;
  coverages: CoverageReport[];
} {
  const css = plan.sections
    .map((section) => emitContent(section.content))
    .filter((section) => section.length > 0)
    .join('\n\n')
    .trim();
  const coverages = plan.sections.flatMap((section) =>
    section.coverage ? [section.coverage] : [],
  );

  return { css, coverages };
}

type GroupableDeclaration = {
  selector: string;
  property: string;
  conditions: readonly string[];
};

type ResolvedDeclaration<T extends GroupableDeclaration> = {
  declaration: T;
  mappedValue: string;
  isSelectorHint: boolean;
};

type MutableStyleRule = Omit<StyleRule, 'declarations'> & {
  declarations: Map<string, string>;
};

// Real authored selectors follow the cascade: the last property value wins.
// Selector hints are approximations, so conflicting values are ambiguous and
// the property is omitted instead of painting unrelated elements alike.
export function groupSelectors<T extends GroupableDeclaration>(
  declarations: readonly ResolvedDeclaration<T>[],
): StyleRule[] {
  const rules = new Map<string, MutableStyleRule>();
  const hintValuesSeen = new Map<string, Set<string>>();

  for (const { declaration, mappedValue, isSelectorHint } of declarations) {
    const ruleKey = `${JSON.stringify(declaration.conditions)}|${declaration.selector}`;
    const rule = rules.get(ruleKey) ?? {
      conditions: declaration.conditions,
      selector: declaration.selector,
      declarations: new Map<string, string>(),
    };
    rules.set(ruleKey, rule);

    if (isSelectorHint) {
      const ambiguityKey = `${ruleKey}|${declaration.property}`;
      const values = hintValuesSeen.get(ambiguityKey) ?? new Set<string>();
      values.add(mappedValue);
      hintValuesSeen.set(ambiguityKey, values);

      if (values.size > 1) {
        rule.declarations.delete(declaration.property);
        continue;
      }
    }

    rule.declarations.set(declaration.property, mappedValue);
  }

  return [...rules.values()].filter((rule) => rule.declarations.size > 0);
}

function emitContent(content: StyleContent): string {
  if (content.kind === 'block') return content.css;
  return content.rules.map(emitRule).join('\n\n');
}

function emitRule(rule: StyleRule): string {
  const declarations = Array.from(rule.declarations.entries())
    .sort(([firstProperty], [secondProperty]) => compareStrings(firstProperty, secondProperty))
    .map(([property, value]) => `  ${property}: ${value} !important;`)
    .join('\n');
  const block = `${scopeSelector(rule.selector)} {\n${declarations}\n}`;

  return rule.conditions.reduceRight(
    (wrapped, condition) => `${condition} {\n${indent(wrapped)}\n}`,
    block,
  );
}

// Site-selector specificity is neutralized inside :where(...), leaving the
// activation gate as the strategy rule's only specificity. Rooted selectors
// receive the gate on their existing html/:root token rather than becoming an
// impossible descendant of a second html element.
function scopeSelector(selector: string): string {
  const match = HTML_ROOT_TOKEN.exec(selector);
  if (!match) return `${GATE} :where(${selector})`;

  const remainder = selector.slice(match[0].length);
  return remainder.length === 0 ? GATE : `${GATE}:where(${remainder})`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
