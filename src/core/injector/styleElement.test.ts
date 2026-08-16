// @vitest-environment happy-dom
// src/core/injector/styleElement.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { composeStylesheet } from '../engine/composeStylesheet';
import { decideStrategies } from '../engine/decisionTable';
import { collectPageFacts } from '../engine/pageFacts';
import { deriveMetrics } from '../engine/pageMetrics';
import { createDefaultSiteSettings, type SiteSettings } from '../storage/settingsStore';
import { builtInThemes } from '../themes';
import {
  injectStylesheet,
  removeStylesheet,
  STYLE_ELEMENT_ID,
  withStylesheetDisabled,
} from './styleElement';

afterEach(() => {
  removeStylesheet();
});

function requireStyleElement(): HTMLStyleElement {
  const element = document.getElementById(STYLE_ELEMENT_ID);
  if (!(element instanceof HTMLStyleElement)) throw new Error('expected style element to exist');
  return element;
}

describe('injectStylesheet / removeStylesheet', () => {
  it('creates the style element with the right id and marks documentElement active', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');

    const element = document.getElementById(STYLE_ELEMENT_ID);
    expect(element).toBeInstanceOf(HTMLStyleElement);
    expect(element?.textContent).toBe(':root { --pm-canvas: #000000; }');
    expect(document.documentElement.dataset.pmActive).toBe('true');
  });

  it('removes the style element and clears the active marker', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');

    removeStylesheet();

    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(document.documentElement.dataset.pmActive).toBeUndefined();
  });

  it('skips the DOM write when the css is unchanged, but updates on real changes', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');
    const element = document.getElementById(STYLE_ELEMENT_ID);
    const textNode = element?.firstChild;
    expect(textNode).toBeTruthy();

    // Same css -> no childList mutation -> same text node reference.
    injectStylesheet(':root { --pm-canvas: #000000; }');
    expect(element?.firstChild).toBe(textNode);

    // Different css -> content updates.
    injectStylesheet(':root { --pm-canvas: #ffffff; }');
    expect(element?.textContent).toBe(':root { --pm-canvas: #ffffff; }');
  });
});

describe('withStylesheetDisabled', () => {
  it('disables the style element during fn and restores it after', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');
    const element = requireStyleElement();

    let disabledDuringFn: boolean | undefined;
    withStylesheetDisabled(() => {
      disabledDuringFn = element.disabled;
    });

    expect(disabledDuringFn).toBe(true);
    expect(element.disabled).toBe(false);
  });

  it('restores disabled=false even when fn throws', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');
    const element = requireStyleElement();

    expect(() =>
      withStylesheetDisabled(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(element.disabled).toBe(false);
  });

  it('returns the value fn produces', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');

    const result = withStylesheetDisabled(() => 42);

    expect(result).toBe(42);
  });

  it('is a no-op wrapper (just runs fn) when the style element is absent', () => {
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();

    const result = withStylesheetDisabled(() => 'ran');

    expect(result).toBe('ran');
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });
});

describe('apply(apply(page)) idempotency invariant', () => {
  it('produces byte-identical CSS and equal metrics on re-apply', () => {
    document.head.innerHTML = `
      <style>
        :root {
          --brand-bg: #1f2430;
          --brand-text: #cdd6f4;
          --brand-border: #45475a;
          --brand-link: #89b4fa;
          --brand-accent: #f38ba8;
          --brand-surface1: #313244;
          --brand-surface2: #45475a;
          --brand-focus: #f9e2af;
        }
        body { background-color: var(--brand-bg); color: var(--brand-text); }
        a { color: var(--brand-link); }
      </style>
    `;
    document.body.innerHTML = '<div><p>hello</p><a href="#">link</a></div>';

    const theme = builtInThemes[0];
    const siteSettings: SiteSettings = {
      ...createDefaultSiteSettings(theme.id),
      strategy: 'auto',
    };

    function applyOnce(): { css: string; metrics: ReturnType<typeof deriveMetrics> } {
      // collectPageFacts must exclude our own injected <style id=STYLE_ELEMENT_ID>
      // (Finding 1's fix) — otherwise the second pass would see one more DOM
      // element than the first and domElementCount would drift.
      const facts = collectPageFacts(document);
      const metrics = deriveMetrics(facts, { mutationRate: 0 });
      const plan = decideStrategies(metrics, siteSettings.strategy);
      const { css } = composeStylesheet(theme, siteSettings, facts, plan);
      injectStylesheet(css);
      return { css, metrics };
    }

    const first = applyOnce();
    const second = applyOnce();

    expect(second.css).toBe(first.css);
    expect(second.metrics).toEqual(first.metrics);
  });
});
