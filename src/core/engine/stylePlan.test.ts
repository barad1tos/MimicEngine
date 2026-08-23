import { describe, expect, it } from 'vitest';
import { emitStylePlan, groupSelectors, type StylePlan, type StyleRule } from './stylePlan';

function ruleOf(
  selector: string,
  declarations: Record<string, string>,
  conditions: readonly string[] = [],
): StyleRule {
  return { conditions, selector, declarations: new Map(Object.entries(declarations)) };
}

function emitRules(rules: readonly StyleRule[]): string {
  return emitStylePlan({ sections: [{ content: { kind: 'rules', rules } }] }).css;
}

describe('emitStylePlan', () => {
  it('emits non-empty sections in order and collects coverage in the same order', () => {
    const plan: StylePlan = {
      sections: [
        {
          content: { kind: 'block', css: ':root { --pm-canvas: #1f2430; }' },
          coverage: { discovered: 4, mapped: 3, ratio: 0.75 },
        },
        { content: { kind: 'block', css: '' } },
        {
          content: {
            kind: 'rules',
            rules: [ruleOf('body', { color: 'var(--pm-text)' })],
          },
          coverage: { discovered: 2, mapped: 1, ratio: 0.5 },
        },
      ],
    };

    expect(emitStylePlan(plan)).toEqual({
      css:
        ':root { --pm-canvas: #1f2430; }\n\n' +
        'html[data-pm-active="true"] :where(body) {\n' +
        '  color: var(--pm-text) !important;\n' +
        '}',
      coverages: [
        { discovered: 4, mapped: 3, ratio: 0.75 },
        { discovered: 2, mapped: 1, ratio: 0.5 },
      ],
    });
  });

  it('returns empty output when every section is empty', () => {
    expect(
      emitStylePlan({
        sections: [
          { content: { kind: 'block', css: '' } },
          { content: { kind: 'rules', rules: [] } },
        ],
      }),
    ).toEqual({
      css: '',
      coverages: [],
    });
  });

  it('preserves rule order while sorting properties and nesting conditions', () => {
    const result = emitStylePlan({
      sections: [
        {
          content: {
            kind: 'rules',
            rules: [
              ruleOf('html.dark .card', { color: '#ffffff', 'background-color': '#111111' }, [
                '@supports (display: grid)',
                '@media print',
              ]),
            ],
          },
        },
      ],
    });

    expect(result.css).toBe(
      '@supports (display: grid) {\n' +
        '  @media print {\n' +
        '    html[data-pm-active="true"]:where(.dark .card) {\n' +
        '      background-color: #111111 !important;\n' +
        '      color: #ffffff !important;\n' +
        '    }\n' +
        '  }\n' +
        '}',
    );
  });

  it('keeps selector-hint ambiguity out of the emitted plan', () => {
    const rules = groupSelectors([
      {
        declaration: { selector: 'div.card', property: 'color', conditions: [] },
        mappedValue: '#111111',
        isSelectorHint: true,
      },
      {
        declaration: { selector: 'div.card', property: 'color', conditions: [] },
        mappedValue: '#222222',
        isSelectorHint: true,
      },
    ]);

    expect(rules).toEqual([]);
  });
});

describe('rule selector scoping', () => {
  it('grafts the gate onto html and :root tokens case-insensitively', () => {
    expect(emitRules([ruleOf('HTML.dark .x', { color: '#fff' })])).toContain(
      'html[data-pm-active="true"]:where(.dark .x) {',
    );
    expect(emitRules([ruleOf(':ROOT', { color: '#fff' })])).toMatch(
      /^html\[data-pm-active="true"] \{/,
    );
  });

  it('collapses bare html and :root without an invalid empty :where()', () => {
    expect(emitRules([ruleOf('html', { color: '#fff' })])).toMatch(
      /^html\[data-pm-active="true"] \{/,
    );
    expect(emitRules([ruleOf(':root', { color: '#fff' })])).toMatch(
      /^html\[data-pm-active="true"] \{/,
    );
  });

  it('wraps ordinary selectors without grafting html-prefixed tag names', () => {
    expect(emitRules([ruleOf('.card', { color: '#fff' })])).toMatch(
      /^html\[data-pm-active="true"] :where\(\.card\) \{/,
    );
    expect(emitRules([ruleOf('html-widget', { color: '#fff' })])).toMatch(
      /^html\[data-pm-active="true"] :where\(html-widget\) \{/,
    );
  });
});

describe('selector grouping', () => {
  it('collapses an identical selector-hint value into one declaration', () => {
    const rules = groupSelectors([
      {
        declaration: { selector: 'div.card', property: 'color', conditions: [] },
        mappedValue: '#111111',
        isSelectorHint: true,
      },
      {
        declaration: { selector: 'div.card', property: 'color', conditions: [] },
        mappedValue: '#111111',
        isSelectorHint: true,
      },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.declarations.get('color')).toBe('#111111');
  });

  it('uses last-value-wins semantics for authored selectors', () => {
    const rules = groupSelectors([
      {
        declaration: { selector: '.hero', property: 'color', conditions: [] },
        mappedValue: '#111111',
        isSelectorHint: false,
      },
      {
        declaration: { selector: '.hero', property: 'color', conditions: [] },
        mappedValue: '#222222',
        isSelectorHint: false,
      },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.declarations.get('color')).toBe('#222222');
  });
});
