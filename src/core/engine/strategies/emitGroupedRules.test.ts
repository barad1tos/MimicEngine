// src/core/engine/strategies/emitGroupedRules.test.ts
import { describe, expect, it } from 'vitest';
import { emitGroupedRules, groupSelectors, type SelectorGroup } from './emitGroupedRules';

function groupOf(
  selector: string,
  declarations: Record<string, string>,
  conditions: readonly string[] = [],
): SelectorGroup {
  return { conditions, selector, declarations: new Map(Object.entries(declarations)) };
}

describe('emitGroupedRules — html/:root grafting', () => {
  it('grafts the gate onto an html-rooted compound selector, wrapping the remainder in :where(...)', () => {
    const css = emitGroupedRules([groupOf('html.dark .x', { color: '#fff' })]);

    expect(css).toContain('html[data-pm-active="true"]:where(.dark .x) {');
  });

  it('grafts case-insensitively for HTML and :ROOT', () => {
    const upperHtml = emitGroupedRules([groupOf('HTML.dark', { color: '#fff' })]);
    const upperRoot = emitGroupedRules([groupOf(':ROOT', { color: '#fff' })]);

    expect(upperHtml).toContain('html[data-pm-active="true"]:where(.dark) {');
    expect(upperRoot.startsWith('html[data-pm-active="true"] {')).toBe(true);
  });

  it('collapses bare :root onto the gate with no trailing space and no :where()', () => {
    const css = emitGroupedRules([groupOf(':root', { color: '#fff' })]);

    expect(css.startsWith('html[data-pm-active="true"] {')).toBe(true);
  });

  it('collapses bare html onto the gate with no trailing space and no :where()', () => {
    const css = emitGroupedRules([groupOf('html', { color: '#fff' })]);

    expect(css.startsWith('html[data-pm-active="true"] {')).toBe(true);
  });

  it('wraps a normal selector in :where(...) after the plain descendant-combinator prefix', () => {
    const css = emitGroupedRules([groupOf('.card', { color: '#fff' })]);

    expect(css.startsWith('html[data-pm-active="true"] :where(.card) {')).toBe(true);
  });

  it('does not graft a tag name that merely starts with "html" (token-boundary check)', () => {
    const css = emitGroupedRules([groupOf('html-widget', { color: '#fff' })]);

    expect(css.startsWith('html[data-pm-active="true"] :where(html-widget) {')).toBe(true);
  });
});

describe('emitGroupedRules — condition wrapping', () => {
  it('wraps a block in its single condition, indented', () => {
    const css = emitGroupedRules([
      groupOf('.card', { color: '#fff' }, ['@media (min-width: 600px)']),
    ]);

    expect(css).toBe(
      '@media (min-width: 600px) {\n' +
        '  html[data-pm-active="true"] :where(.card) {\n' +
        '    color: #fff !important;\n' +
        '  }\n' +
        '}',
    );
  });

  it('nests multiple conditions outermost-first', () => {
    const css = emitGroupedRules([
      groupOf('.card', { color: '#fff' }, ['@supports (display: grid)', '@media print']),
    ]);

    expect(css.startsWith('@supports (display: grid) {')).toBe(true);
    expect(css).toContain('@media print {');
    const supportsIndex = css.indexOf('@supports');
    const mediaIndex = css.indexOf('@media print');
    expect(mediaIndex).toBeGreaterThan(supportsIndex);
  });

  it('leaves an empty-conditions block unwrapped (top-level unaffected)', () => {
    const css = emitGroupedRules([groupOf('.card', { color: '#fff' })]);

    expect(css.startsWith('html[data-pm-active="true"]')).toBe(true);
    expect(css).not.toContain('@media');
  });
});

describe('emitGroupedRules — empty input', () => {
  it('returns an empty string for no groups', () => {
    expect(emitGroupedRules([])).toBe('');
  });
});

describe('groupSelectors — selector-hint ambiguity', () => {
  it('drops a property when a selector-hint declaration collides with a different mapped value', () => {
    const groups = groupSelectors([
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

    expect(groups).toEqual([]);
  });

  it('keeps one declaration when a selector-hint collision repeats the identical value', () => {
    const groups = groupSelectors([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.declarations.get('color')).toBe('#111111');
  });

  it('uses ordinary last-value-wins cascade semantics for non-hint declarations', () => {
    const groups = groupSelectors([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.declarations.get('color')).toBe('#222222');
  });
});
