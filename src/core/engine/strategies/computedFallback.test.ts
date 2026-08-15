// @vitest-environment happy-dom
// src/core/engine/strategies/computedFallback.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as collectComputedColorsModule from '../../analyzer/collectComputedColors';
import { injectStylesheet, removeStylesheet, STYLE_ELEMENT_ID } from '../../injector/styleElement';
import type { SiteSettings } from '../../storage/settingsStore';
import { builtInThemes } from '../../themes';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import { computedFallback } from './computedFallback';

const catppuccinFrappe = builtInThemes[0];

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

function anySiteSettings(preserveBrandColors = true): SiteSettings {
  return {
    enabled: true,
    themeId: catppuccinFrappe.id,
    strategy: 'auto',
    preserveImages: true,
    preserveBrandColors,
    overrides: [],
  };
}

function emptyFacts(): PageFacts {
  return {
    customProperties: [],
    authoredRules: [],
    inlineStyleColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    styleSheetCount: 0,
    unreadableStyleSheetCount: 0,
  };
}

function factsWithAuthoredRule(rule: AuthoredColorDeclaration): PageFacts {
  return { ...emptyFacts(), authoredRules: [rule] };
}

function requireStyleElement(): HTMLStyleElement {
  const element = document.getElementById(STYLE_ELEMENT_ID);
  if (!(element instanceof HTMLStyleElement)) throw new Error('expected style element to exist');
  return element;
}

beforeEach(() => {
  // happy-dom's layout engine always reports zero-size rects; stub it so
  // collectComputedColors' visibility filter lets our fixture elements
  // through, same as any real, laid-out page element would be.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(VISIBLE_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
  removeStylesheet();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('computedFallback strategy', () => {
  it('returns an empty string when there is nothing to sample', () => {
    const css = computedFallback.produceCss(catppuccinFrappe, anySiteSettings(), emptyFacts());

    expect(css).toBe('');
  });

  it('samples with the injected stylesheet disabled and restores it after', () => {
    injectStylesheet(':root { --pm-canvas: #000000; }');
    const styleElement = requireStyleElement();
    document.body.innerHTML = '<p>hello</p>';

    const original = collectComputedColorsModule.collectComputedColors;
    let disabledDuringSampling: boolean | undefined;
    vi.spyOn(collectComputedColorsModule, 'collectComputedColors').mockImplementation((...args) => {
      disabledDuringSampling = styleElement.disabled;
      return original(...args);
    });

    computedFallback.produceCss(catppuccinFrappe, anySiteSettings(), emptyFacts());

    expect(disabledDuringSampling).toBe(true);
    expect(styleElement.disabled).toBe(false);
  });

  it('does not re-emit a sampled color already covered by authored facts', () => {
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const facts = factsWithAuthoredRule({
      selector: '.hero',
      property: 'color',
      value: '#ff0000',
      color: { r: 255, g: 0, b: 0, a: 1 },
      bucket: 'text',
    });

    const css = computedFallback.produceCss(catppuccinFrappe, anySiteSettings(), facts);

    expect(css).toBe('');
  });

  it('maps and emits a novel color invisible to authored analysis, marked !important', () => {
    document.head.innerHTML = '<style>.hero { color: rgb(20, 30, 40); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const css = computedFallback.produceCss(catppuccinFrappe, anySiteSettings(), emptyFacts());

    expect(css).toContain('html[data-pm-active="true"] p.hero {');
    expect(css).toContain('color:');
    expect(css).toContain('!important');
  });

  it('snapshot: emits a grouped stylesheet from novel sampled colors', () => {
    document.head.innerHTML = `
      <style>
        .hero { color: rgb(20, 30, 40); }
        .panel { background-color: rgb(200, 210, 220); }
      </style>
    `;
    document.body.innerHTML = '<p class="hero">text</p><div class="panel">panel text</div>';

    const css = computedFallback.produceCss(catppuccinFrappe, anySiteSettings(), emptyFacts());

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] p.hero {
        color: #c6d0f5 !important;
      }

      html[data-pm-active="true"] div.panel {
        background-color: #303446 !important;
      }"
    `);
  });
});
