// @vitest-environment happy-dom
// src/core/engine/pageFacts.test.ts
import { describe, expect, it } from 'vitest';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';
import { collectFromSheets, collectPageFacts } from './pageFacts';

function buildDocument(css: string, bodyHtml = '<p>hi</p>'): Document {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = bodyHtml;
  return document;
}

describe('collectPageFacts', () => {
  it('collects color-valued custom properties from :root with usage counts', () => {
    const doc = buildDocument(`
      :root { --brand-bg: #1f2430; --brand-text: rgb(200, 200, 200); --spacing: 4px; }
      body { background-color: var(--brand-bg); color: var(--brand-text); }
      a { border-color: var(--brand-bg); }
    `);
    const facts = collectPageFacts(doc);
    const names = facts.customProperties.map((p) => p.name);
    expect(names).toEqual(['--brand-bg', '--brand-text', '--spacing']);
    const bg = facts.customProperties[0];
    expect(bg?.color).toEqual({ r: 31, g: 36, b: 48, a: 1 });
    expect(bg?.usage).toEqual({ background: 1, text: 0, border: 1, other: 0 });
    expect(facts.customProperties[2]?.color).toBeNull();
  });

  it('counts usage when var() has whitespace after the opening paren', () => {
    const doc = buildDocument(`
      :root { --brand-bg: #1f2430; }
      body { background-color: var( --brand-bg); }
    `);
    const facts = collectPageFacts(doc);
    const bg = facts.customProperties.find((p) => p.name === '--brand-bg');
    expect(bg?.usage).toEqual({ background: 1, text: 0, border: 0, other: 0 });
  });

  it('skips var() chained declarations and our own style element', () => {
    document.head.innerHTML = `
      <style>
        .theme { --brand-bg: #101010; }
        :root { --alias: var(--brand-bg); }
      </style>
      <style id="${STYLE_ELEMENT_ID}">:root { --pm-canvas: #000000; }</style>
    `;
    const facts = collectPageFacts(document);
    expect(facts.customProperties.map((p) => p.name)).toEqual([]);
  });

  it('counts elements and respects maxCustomProperties budget', () => {
    const doc = buildDocument(
      ':root { --a: #111111; --b: #222222; --c: #333333; }',
      '<div><span></span></div>',
    );
    const facts = collectPageFacts(doc, { maxCustomProperties: 2 });
    expect(facts.customProperties).toHaveLength(2);
    expect(facts.domElementCount).toBeGreaterThan(0);
  });

  it('excludes its own injected style element from domElementCount and shadowRootCount', () => {
    const css = ':root { --brand-bg: #1f2430; }';
    const bodyHtml = '<div><span></span><p>hi</p></div>';

    const withoutOwnStyle = collectPageFacts(buildDocument(css, bodyHtml));

    document.head.innerHTML = `<style>${css}</style><style id="${STYLE_ELEMENT_ID}">:root { --pm-canvas: #000000; }</style>`;
    document.body.innerHTML = bodyHtml;
    const withOwnStyle = collectPageFacts(document);

    expect(withOwnStyle.domElementCount).toBe(withoutOwnStyle.domElementCount);
    expect(withOwnStyle.shadowRootCount).toBe(withoutOwnStyle.shadowRootCount);
  });

  it('excludes its own injected style element from authoredRules and inlineStyleColors', () => {
    document.head.innerHTML = `
      <style>.foo { color: #ff0000; }</style>
      <style id="${STYLE_ELEMENT_ID}">.bar { color: #00ff00; }</style>
    `;
    document.body.innerHTML = '<div style="color: #0000ff;"></div>';
    const facts = collectPageFacts(document);
    expect(facts.authoredRules).toHaveLength(1);
    expect(facts.authoredRules[0]?.selector).toBe('.foo');
    expect(facts.inlineStyleColors).toHaveLength(1);
  });

  it('recurses into @media rules and collects authored color declarations', () => {
    const doc = buildDocument(`
      .plain { background-color: #101010; }
      @media (min-width: 1px) {
        .nested { color: #123456; }
      }
    `);
    const facts = collectPageFacts(doc);
    const nested = facts.authoredRules.find((rule) => rule.selector === '.nested');
    expect(nested).toEqual({
      selector: '.nested',
      property: 'color',
      value: '#123456',
      color: { r: 0x12, g: 0x34, b: 0x56, a: 1 },
      bucket: 'text',
    });
    expect(facts.authoredRules.some((rule) => rule.selector === '.plain')).toBe(true);
  });

  it('matches custom properties from an arbitrary comma-separated selector list containing :root/html', () => {
    const doc = buildDocument(`
      .theme-a,
        :root ,
      html { --brand-bg: #1f2430; }
    `);
    const facts = collectPageFacts(doc);
    expect(facts.customProperties.map((p) => p.name)).toEqual(['--brand-bg']);
  });

  it('collects inline style colors with a selector hint', () => {
    const doc = buildDocument('', '<p id="hero" style="color: #123456;">hi</p>');
    const facts = collectPageFacts(doc);
    expect(facts.inlineStyleColors).toEqual([
      {
        selector: '#hero',
        property: 'color',
        value: '#123456',
        color: { r: 0x12, g: 0x34, b: 0x56, a: 1 },
        bucket: 'text',
      },
    ]);
  });

  it('builds a class-based selector hint when the element has no id', () => {
    const doc = buildDocument('', '<span class="a b c" style="color: #123456;">hi</span>');
    const facts = collectPageFacts(doc);
    expect(facts.inlineStyleColors[0]?.selector).toBe('span.a.b');
  });

  it('truncates authoredRules deterministically at maxAuthoredDeclarations', () => {
    const css = Array.from(
      { length: 5 },
      (_, index) => `.rule-${index.toString()} { color: #000000; }`,
    ).join('\n');
    const doc = buildDocument(css);
    const facts = collectPageFacts(doc, { maxAuthoredDeclarations: 2 });
    expect(facts.authoredRules).toHaveLength(2);
    expect(facts.authoredRules.map((rule) => rule.selector)).toEqual(['.rule-0', '.rule-1']);
  });

  it('shares maxAuthoredDeclarations between authoredRules and inlineStyleColors, sheet walk first', () => {
    const doc = buildDocument(
      '.a { color: #111111; } .b { color: #222222; }',
      '<p id="one" style="color: #333333;"></p><p id="two" style="color: #444444;"></p>',
    );
    const facts = collectPageFacts(doc, { maxAuthoredDeclarations: 3 });
    expect(facts.authoredRules).toHaveLength(2);
    expect(facts.inlineStyleColors).toHaveLength(1);
  });

  it('splits a multi-selector rule into one AuthoredColorDeclaration per selector', () => {
    const doc = buildDocument('.a, .b { color: #123456; }');
    const facts = collectPageFacts(doc);
    expect(facts.authoredRules).toHaveLength(2);
    expect(facts.authoredRules.map((rule) => rule.selector)).toEqual(['.a', '.b']);
    expect(facts.authoredRules.some((rule) => rule.selector.includes(','))).toBe(false);
  });

  it('keeps a comma inside :is(...) as part of one selector (paren-aware split)', () => {
    const doc = buildDocument(':is(.a, .b) .x { color: #123456; }');
    const facts = collectPageFacts(doc);
    expect(facts.authoredRules).toHaveLength(1);
    expect(facts.authoredRules[0]?.selector).toBe(':is(.a, .b) .x');
  });

  it('keeps a comma inside an attribute-value string as part of one selector (quote-aware split)', () => {
    const doc = buildDocument('[title="a,b"] { color: #123456; }');
    const facts = collectPageFacts(doc);
    expect(facts.authoredRules).toHaveLength(1);
    expect(facts.authoredRules[0]?.selector).toBe('[title="a,b"]');
  });

  it('counts an unreadable stylesheet without throwing, via the collectFromSheets seam', () => {
    const throwingSheet = {
      get cssRules(): CSSRuleList {
        throw new Error('inaccessible cross-origin sheet');
      },
    } as unknown as CSSStyleSheet;

    const result = collectFromSheets([throwingSheet], {
      maxRules: 5000,
      maxAuthoredDeclarations: 1000,
    });

    expect(result.unreadableStyleSheetCount).toBe(1);
    expect(result.styleSheetCount).toBe(1);
    expect(result.authoredRules).toEqual([]);
  });
});
