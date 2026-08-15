// @vitest-environment happy-dom
// src/core/engine/pageFacts.test.ts
import { describe, expect, it } from 'vitest';
import { STYLE_ELEMENT_ID } from '../injector/styleElement';
import { collectPageFacts } from './pageFacts';

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
});
