// @vitest-environment happy-dom
// src/core/injector/styleElement.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignatureCensus, installCensus } from '../analyzer/signatureCensus';
import { composeStylesheet } from '../engine/composeStylesheet';
import { decideStrategies } from '../engine/decisionTable';
import { collectPageFacts } from '../engine/pageFacts';
import { deriveMetrics } from '../engine/pageMetrics';
import { createDefaultSiteSettings, type SiteSettings } from '../storage/settingsStore';
import { builtInThemes, type PaletteTheme } from '../themes';
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

// happy-dom's layout engine always reports zero-size rects; stubbing
// getBoundingClientRect (same fixture as computedFallback.test.ts) lets the
// census' visibility filter admit our fixture elements, same as any real,
// laid-out page element would be.
const VISIBLE_RECT = {
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  left: 0,
  right: 100,
  bottom: 20,
  toJSON: () => ({}),
} as DOMRect;

describe('apply(apply(page)) idempotency invariant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    installCensus(null);
  });

  // Shared M4 fixture: the calm-variables-rich custom properties from the
  // original fixture, plus an inline SVG carrying fill/stroke presentation
  // attributes and an element with a style="" attribute — the surface
  // deepRemap (and authoredRemap's inlineStyleColors reads) walk that the
  // pre-M4 fixture never exercised.
  function renderFixturePage(): void {
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
    document.body.innerHTML = `
      <div>
        <p>hello</p>
        <a href="#">link</a>
        <span style="color: #585b70;">inline-styled</span>
        <svg viewBox="0 0 10 10">
          <circle cx="5" cy="5" r="4" fill="#3a3a44" stroke="#101014" />
        </svg>
      </div>
    `;
  }

  // Fixture for a DOM whose only color signal is invisible to authored
  // analysis (no custom properties, no readable-sheet budget relevant here)
  // and visible only to the census — the manual computedFallback pick below
  // is the sole strategy in the plan, so this exercises the census-bootstrap
  // path through the determinism/idempotency invariants.
  function renderComputedFallbackFixturePage(): void {
    document.head.innerHTML = `
      <style>
        .hero { color: rgb(20, 30, 40); }
      </style>
    `;
    document.body.innerHTML = `
      <p class="hero">census-sampled text</p>
    `;
  }

  // Builds a census over the current document and installs it, the same way
  // pageThemeController installs its live census before invoking the plan —
  // mirrors computedFallback.test.ts's own censusFromCurrentDom helper.
  function censusFromCurrentDom(): void {
    const census = createSignatureCensus();
    census.begin(document);
    while (!census.advance(1000)) {
      /* drain */
    }
    installCensus(census);
  }

  // collectPageFacts must exclude our own injected <style id=STYLE_ELEMENT_ID>
  // (Finding 1's fix) — otherwise the second pass would see one more DOM
  // element than the first and domElementCount would drift.
  function applyOnce(
    theme: PaletteTheme,
    siteSettings: SiteSettings,
  ): { css: string; metrics: ReturnType<typeof deriveMetrics> } {
    const facts = collectPageFacts(document);
    const metrics = deriveMetrics(facts, { mutationRate: 0 });
    const plan = decideStrategies(metrics, siteSettings.strategy);
    const { css } = composeStylesheet(theme, siteSettings, facts, plan);
    injectStylesheet(css);
    return { css, metrics };
  }

  it('produces byte-identical CSS and equal metrics on re-apply — auto plan', () => {
    renderFixturePage();
    const theme = builtInThemes[0];
    const siteSettings: SiteSettings = {
      ...createDefaultSiteSettings(theme.id),
      strategy: 'auto',
    };

    const first = applyOnce(theme, siteSettings);
    const second = applyOnce(theme, siteSettings);

    expect(second.css).toBe(first.css);
    expect(second.metrics).toEqual(first.metrics);
  });

  it('produces byte-identical CSS and equal metrics on re-apply — manual deepRemap plan composed over the auto row', () => {
    renderFixturePage();
    const theme = builtInThemes[0];
    const siteSettings: SiteSettings = {
      ...createDefaultSiteSettings(theme.id),
      strategy: 'deepRemap',
    };

    const first = applyOnce(theme, siteSettings);
    const second = applyOnce(theme, siteSettings);

    expect(second.css).toBe(first.css);
    expect(second.metrics).toEqual(first.metrics);
  });

  it('produces byte-identical CSS and equal metrics on re-apply — manual computedFallback plan reading the installed census', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(VISIBLE_RECT);
    renderComputedFallbackFixturePage();
    censusFromCurrentDom();

    const theme = builtInThemes[0];
    const siteSettings: SiteSettings = {
      ...createDefaultSiteSettings(theme.id),
      strategy: 'computedFallback',
    };

    const first = applyOnce(theme, siteSettings);
    const second = applyOnce(theme, siteSettings);

    expect(second.css).toBe(first.css);
    expect(second.metrics).toEqual(first.metrics);
    // Sanity: the census path actually fired a rule, not a trivial empty match.
    expect(first.css).toContain('!important');
  });
});
