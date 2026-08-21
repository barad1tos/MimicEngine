// @vitest-environment happy-dom
// src/core/injector/styleElement.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignatureCensus, installCensus } from '../analyzer/signatureCensus';
import { contrastRatio } from '../color/contrast';
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
  // path through the determinism/idempotency invariants. Also carries the
  // elevation-paired-guard plan's two new mechanisms, so the full pipeline
  // (not just computedFallback.test.ts in isolation) proves them stable
  // across a double run: `.ground`/`.card` share one raw background hex at
  // two visual surface levels — elevation is a surface level, not a raw
  // ancestor count, so `.card` also carries its own box-shadow: that's the
  // real boundary that makes it a distinct surface from `.ground` despite
  // the identical hex — the composite hex@elevation mapping key must route
  // them to different surface tokens. `.pill` pairs a
  // saturated green background with near-white text — the RAW site pair is
  // perfectly readable (~5.22:1). Remapping is what breaks it: the raw
  // background maps to the theme's accent-ish `success` token (`#a6d189`)
  // while the plain text-bucket mapping stays the theme's global `text`
  // token (`#c6d0f5`), and THAT mapped pair fails at ~1.135:1. The
  // per-selector paired guard (carried over from Task 4's review as a gap in
  // the invariant double-run) must fire and restore >=4.5:1 for the emitted
  // pair.
  function renderComputedFallbackFixturePage(): void {
    document.head.innerHTML = `
      <style>
        .hero { color: rgb(20, 30, 40); }
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
        .pill { background-color: rgb(1, 117, 79); color: rgb(244, 244, 244); }
      </style>
    `;
    document.body.innerHTML = `
      <p class="hero">census-sampled text</p>
      <div class="ground"><div class="card">x</div></div>
      <span class="pill">All</span>
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

    // Elevation ladder: .ground and .card share one raw background hex but
    // .card's own box-shadow is a real surface boundary, putting them at two
    // different elevations — the full pipeline must still emit two DIFFERENT
    // `var(--pm-elevation-N)` values for them (Amendment 3: the ladder now
    // targets the universal elevation ramp, substituted at render time —
    // see computedFallback.ts), proving the composite hex@elevation mapping
    // key survives collectPageFacts -> decide -> compose end to end, not
    // just in computedFallback.produce called directly.
    const groundBlock = /:where\(div\.ground\) \{[^}]*\}/.exec(first.css)?.[0] ?? '';
    const cardBlock = /:where\(div\.card\) \{[^}]*\}/.exec(first.css)?.[0] ?? '';
    const groundBg = /background-color: (var\(--pm-elevation-\d\))/.exec(groundBlock)?.[1];
    const cardBg = /background-color: (var\(--pm-elevation-\d\))/.exec(cardBlock)?.[1];
    expect(groundBg).toBeDefined();
    expect(cardBg).toBeDefined();
    expect(groundBg).not.toBe(cardBg);

    // Island shadow: .card's own box-shadow is the elevation boundary that
    // puts it at elevation >= 1, so the full pipeline (not just
    // computedFallback.produce in isolation) must emit `box-shadow:
    // var(--pm-shadow-1)` in the SAME rule block — the flat ground rung
    // (elevation 0) casts none.
    expect(groundBlock).not.toContain('box-shadow');
    expect(cardBlock).toContain('box-shadow: var(--pm-shadow-1) !important;');

    // Paired-override guard: .pill's raw site pair is readable (~5.22:1) —
    // remapping is what breaks it: the raw background maps to the theme's
    // accent-ish `success` token while the plain text-bucket mapping stays
    // the theme's global `text` token, and that mapped pair fails at
    // ~1.135:1. The per-selector guard must fire through the full pipeline
    // and restore >=4.5:1 for the emitted pair, across the double run (the
    // fired-override path Task 4's review flagged as untested by any
    // invariant double-run).
    const pillBlock = /:where\(span\.pill\) \{[^}]*\}/.exec(first.css)?.[0] ?? '';
    const pillBg = /background-color: (#\w{6})/.exec(pillBlock)?.[1];
    const pillText = /(?<!background-)color: (#\w{6})/.exec(pillBlock)?.[1];
    expect(pillBg).toBeDefined();
    expect(pillText).toBeDefined();
    if (pillBg === undefined || pillText === undefined)
      throw new Error('expected both bg and text for .pill');
    expect(contrastRatio(pillText, pillBg)).toBeGreaterThanOrEqual(4.5);
  });
});
