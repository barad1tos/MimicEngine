// @vitest-environment happy-dom
// src/core/engine/pageFacts.test.ts
import { describe, expect, it } from 'vitest';
import { STYLE_ELEMENT_ID, TRANSITION_KILL_ELEMENT_ID } from '../injector/styleElement';
import { collectFromSheets, collectPageFacts } from './pageFacts';
import { deriveMetrics } from './pageMetrics';

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

  // Amendment 3.8: withStylesheetDisabled's transition-kill element must be
  // excluded from facts collection exactly like the generated style element —
  // dormant today (collectPageFacts never runs inside that window), but spec
  // fidelity, not current call-site topology, is what this locks in.
  it('excludes the transition-kill element from domElementCount, shadowRootCount, and its own stylesheet from authoredRules', () => {
    const bodyHtml = '<div><span></span><p>hi</p></div>';

    const withoutKillElement = collectPageFacts(
      buildDocument('.foo { color: #ff0000; }', bodyHtml),
    );

    // The kill element's own stylesheet carries a color declaration here
    // (rather than the real '* { transition: none !important; }' payload) so
    // that a leaking exclusion would surface as a SECOND authoredRules entry
    // — asserting against its real content would pass vacuously either way,
    // since 'transition: none' has no color for collectFromSheets to pick up.
    document.head.innerHTML = `
      <style>.foo { color: #ff0000; }</style>
      <style id="${TRANSITION_KILL_ELEMENT_ID}">.bar { color: #00ff00; }</style>
    `;
    document.body.innerHTML = bodyHtml;
    const withKillElement = collectPageFacts(document);

    expect(withKillElement.domElementCount).toBe(withoutKillElement.domElementCount);
    expect(withKillElement.shadowRootCount).toBe(withoutKillElement.shadowRootCount);
    expect(withKillElement.authoredRules).toHaveLength(1);
    expect(withKillElement.authoredRules[0]?.selector).toBe('.foo');
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
      conditions: ['@media (min-width: 1px)'],
    });
    const plain = facts.authoredRules.find((rule) => rule.selector === '.plain');
    expect(plain?.conditions).toEqual([]);
  });

  it('records @supports conditionText alongside @media mediaText, outermost-first', () => {
    const doc = buildDocument(`
      @supports (display: grid) {
        @media print {
          .nested { color: #123456; }
        }
      }
    `);
    const facts = collectPageFacts(doc);
    const nested = facts.authoredRules.find((rule) => rule.selector === '.nested');
    expect(nested?.conditions).toEqual(['@supports (display: grid)', '@media print']);
  });

  it('never appends a custom-property declaration to authoredRules or inlineStyleColors', () => {
    document.head.innerHTML = '<style>:root { --brand-bg: #101010; }</style>';
    document.body.innerHTML = '<p style="--brand-fg: #202020; color: #303030;">hi</p>';
    const facts = collectPageFacts(document);

    expect(facts.authoredRules.some((rule) => rule.property.startsWith('--'))).toBe(false);
    expect(facts.inlineStyleColors.some((rule) => rule.property.startsWith('--'))).toBe(false);
    expect(facts.inlineStyleColors.map((rule) => rule.property)).toEqual(['color']);
  });

  it('collects a bare html selector alone (no :root present) as a root selector', () => {
    // Falsifiable against a ROOT_SELECTORS regression: if 'html' were ever
    // dropped from the set (or only ':root' were checked), this alone-html
    // stylesheet would collect nothing.
    const doc = buildDocument('html { --brand-bg: #1f2430; }');
    const facts = collectPageFacts(doc);
    expect(facts.customProperties.map((p) => p.name)).toEqual(['--brand-bg']);
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
        conditions: [],
      },
    ]);
  });

  it('builds a class-based selector hint when the element has no id', () => {
    const doc = buildDocument('', '<span class="a b c" style="color: #123456;">hi</span>');
    const facts = collectPageFacts(doc);
    expect(facts.inlineStyleColors[0]?.selector).toBe('span.a.b');
  });

  it('excludes an inline !important declaration — no CSS strategy can ever beat it in the cascade', () => {
    const doc = buildDocument('', '<p style="color: #123456 !important;">hi</p>');
    const facts = collectPageFacts(doc);
    expect(facts.inlineStyleColors).toHaveLength(0);
  });

  it('still collects a non-important inline declaration alongside an excluded !important sibling', () => {
    const doc = buildDocument(
      '',
      '<p style="color: #123456 !important; background-color: #654321;">hi</p>',
    );
    const facts = collectPageFacts(doc);
    expect(facts.inlineStyleColors).toHaveLength(1);
    expect(facts.inlineStyleColors[0]?.property).toBe('background-color');
  });

  it('reflects the !important exclusion in inlineStyleColorCount', () => {
    const doc = buildDocument(
      '',
      '<p style="color: #123456 !important; background-color: #654321;"></p>',
    );
    const facts = collectPageFacts(doc);
    const metrics = deriveMetrics(facts, { mutationRate: 0 });
    expect(metrics.inlineStyleColorCount).toBe(1);
  });

  it('truncates rule visitation deterministically at maxRules', () => {
    const css = Array.from(
      { length: 5 },
      (_, index) => `.rule-${index.toString()} { color: #000000; }`,
    ).join('\n');
    const doc = buildDocument(css);
    const facts = collectPageFacts(doc, { maxRules: 3 });
    expect(facts.authoredRules).toHaveLength(3);
    expect(facts.authoredRules.map((rule) => rule.selector)).toEqual([
      '.rule-0',
      '.rule-1',
      '.rule-2',
    ]);
  });

  it('truncates DOM element counting deterministically at maxElements', () => {
    const doc = buildDocument('', '<div></div><div></div><div></div><div></div><div></div>');
    const facts = collectPageFacts(doc, { maxElements: 3 });
    expect(facts.domElementCount).toBe(3);
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

  // happy-dom's CSS parser drops any rule whose selector text contains a
  // backslash escape (cssRules stays empty), so an escaped selector can't
  // reach splitSelectorList through <style> text the way the tests above do.
  // Instead we take a real, parseable CSSStyleRule (so `style` and
  // `instanceof CSSStyleRule` stay genuine) and override just its read-only
  // `selectorText` getter, then drive it through the same collectFromSheets
  // seam the unreadable-stylesheet tests below already use.
  function ruleWithSelectorText(selectorText: string): CSSStyleRule {
    document.head.innerHTML = '<style>.placeholder { color: #123456; }</style>';
    const rule = document.styleSheets[0]?.cssRules[0];
    if (!(rule instanceof CSSStyleRule)) throw new Error('expected a parsed CSSStyleRule');
    Object.defineProperty(rule, 'selectorText', { value: selectorText, configurable: true });
    return rule;
  }

  it('keeps an escaped comma as part of one selector (escape-aware split)', () => {
    const rule = ruleWithSelectorText('.a\\, .b');
    const result = collectFromSheets([{ cssRules: [rule] } as unknown as CSSStyleSheet], {
      maxRules: 5000,
      maxAuthoredDeclarations: 1000,
    });
    expect(result.authoredRules).toHaveLength(1);
    expect(result.authoredRules[0]?.selector).toBe('.a\\, .b');
  });

  it('keeps an escaped quote inside a selector string from ending the quote early', () => {
    const rule = ruleWithSelectorText('[title="a\\",b"], .next');
    const result = collectFromSheets([{ cssRules: [rule] } as unknown as CSSStyleSheet], {
      maxRules: 5000,
      maxAuthoredDeclarations: 1000,
    });
    expect(result.authoredRules).toHaveLength(2);
    expect(result.authoredRules.map((declaration) => declaration.selector)).toEqual([
      '[title="a\\",b"]',
      '.next',
    ]);
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

    expect(result.unreadableStylesheetCount).toBe(1);
    expect(result.stylesheetCount).toBe(1);
    expect(result.authoredRules).toEqual([]);
  });

  it('continues to a subsequent readable sheet after an unreadable one (continue, not return)', () => {
    const throwingSheet = {
      get cssRules(): CSSRuleList {
        throw new Error('inaccessible cross-origin sheet');
      },
    } as unknown as CSSStyleSheet;

    document.head.innerHTML = '<style>.readable { color: #123456; }</style>';
    const readableSheet = document.styleSheets[0];
    if (!readableSheet) throw new Error('expected a readable stylesheet to exist');

    const result = collectFromSheets([throwingSheet, readableSheet], {
      maxRules: 5000,
      maxAuthoredDeclarations: 1000,
    });

    expect(result.unreadableStylesheetCount).toBe(1);
    expect(result.stylesheetCount).toBe(2);
    expect(result.authoredRules).toHaveLength(1);
    expect(result.authoredRules[0]?.selector).toBe('.readable');
  });

  it('collects svg presentation-attribute fill/stroke colors, deduped and codepoint-sorted', () => {
    const doc = buildDocument(
      '',
      `
        <svg>
          <path fill="#ff0000"></path>
          <circle stroke="rgb(0, 128, 0)"></circle>
          <rect fill="none"></rect>
          <g fill="currentColor"></g>
          <path fill="#ff0000"></path>
        </svg>
      `,
    );
    const facts = collectPageFacts(doc);
    expect(facts.svgPresentationColors).toEqual([
      { attribute: 'fill', value: '#ff0000', color: { r: 0xff, g: 0, b: 0, a: 1 } },
      { attribute: 'stroke', value: 'rgb(0, 128, 0)', color: { r: 0, g: 128, b: 0, a: 1 } },
    ]);
  });

  it('ignores fill/stroke attributes on elements outside any <svg> ancestor', () => {
    const doc = buildDocument('', '<div fill="#123456"></div>');
    const facts = collectPageFacts(doc);
    expect(facts.svgPresentationColors).toEqual([]);
  });

  it('truncates svgPresentationColors deterministically at the maxSvgPresentationColors budget', () => {
    const paths = Array.from(
      { length: 65 },
      (_, index) => `<path fill="#${(index + 1).toString(16).padStart(6, '0')}"></path>`,
    ).join('');
    const doc = buildDocument('', `<svg>${paths}</svg>`);
    const facts = collectPageFacts(doc);
    expect(facts.svgPresentationColors).toHaveLength(64);
    expect(facts.svgPresentationColors[0]?.value).toBe('#000001');
    expect(facts.svgPresentationColors[63]?.value).toBe('#000040');
  });
});
