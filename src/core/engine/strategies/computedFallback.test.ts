// @vitest-environment happy-dom
// src/core/engine/strategies/computedFallback.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as collectComputedColorsModule from '../../analyzer/collectComputedColors';
import { injectStylesheet, removeStylesheet, STYLE_ELEMENT_ID } from '../../injector/styleElement';
import type { SiteSettings } from '../../storage/settingsStore';
import { builtInThemes } from '../../themes';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { StrategyId } from '../strategyId';
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
    svgPresentationColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    stylesheetCount: 0,
    unreadableStylesheetCount: 0,
  };
}

function factsWithAuthoredRule(rule: AuthoredColorDeclaration): PageFacts {
  return { ...emptyFacts(), authoredRules: [rule] };
}

function planWith(strategies: StrategyId[]): StrategyPlan {
  return {
    provenance: {
      kind: 'auto',
      rule: 'test',
      strategies,
      reasons: [],
      tableVersion: TABLE_VERSION,
    },
  };
}

// Matches produce's real call site (composeStylesheet only invokes a
// strategy when it's in the plan), so the default fixture always includes
// computedFallback alongside authoredRemap — exercising the stoplist
// suppression these tests are built around.
const planWithAuthoredRemap = planWith(['baseline', 'authoredRemap', 'computedFallback']);
const planWithoutAuthoredRemap = planWith(['baseline', 'computedFallback']);

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
    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

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

    computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

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
      conditions: [],
    });

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      facts,
      planWithAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('remaps an authored-covered color when the plan has no authoredRemap (stoplist not built)', () => {
    // Same fixture as the suppression test above, but authoredRemap is not
    // in the plan — e.g. an opaque page where computedFallback is the only
    // strategy that can see colors at all. Without authoredRemap running,
    // there is nothing for the stoplist to protect against double-emission,
    // so the red the page actually authored must still get remapped.
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const facts = factsWithAuthoredRule({
      selector: '.hero',
      property: 'color',
      value: '#ff0000',
      color: { r: 255, g: 0, b: 0, a: 1 },
      bucket: 'text',
      conditions: [],
    });

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      facts,
      planWithoutAuthoredRemap,
    );

    expect(css).toContain('html[data-pm-active="true"] :where(p.hero) {');
    expect(css).toContain('color:');
  });

  it('does not let a translucent authored declaration suppress an opaque novel sample of the same RGB', () => {
    // The authored side has only a translucent (a: 0.5) red; the page's
    // actual computed color for .hero is fully opaque. The stoplist must not
    // treat the translucent authored entry as covering the opaque sample —
    // isOpaque gates what enters collectAuthoredHexes, same as line 97 gates
    // what enters the sample pipeline itself.
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const facts = factsWithAuthoredRule({
      selector: '.scrim',
      property: 'color',
      value: 'rgba(255, 0, 0, 0.5)',
      color: { r: 255, g: 0, b: 0, a: 0.5 },
      bucket: 'text',
      conditions: [],
    });

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      facts,
      planWithAuthoredRemap,
    );

    expect(css).toContain('html[data-pm-active="true"] :where(p.hero) {');
    expect(css).toContain('color:');
  });

  it('maps and emits a novel color invisible to authored analysis, marked !important', () => {
    document.head.innerHTML = '<style>.hero { color: rgb(20, 30, 40); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

    expect(css).toContain('html[data-pm-active="true"] :where(p.hero) {');
    expect(css).toContain('color:');
    expect(css).toContain('!important');
  });

  it('does not emit a translucent computed color, even though it is otherwise novel', () => {
    document.head.innerHTML = '<style>.scrim { color: rgba(20, 30, 40, 0.5); }</style>';
    document.body.innerHTML = '<p class="scrim">text</p>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('snapshot: emits a grouped stylesheet from novel sampled colors', () => {
    document.head.innerHTML = `
      <style>
        .hero { color: rgb(20, 30, 40); }
        .panel { background-color: rgb(200, 210, 220); }
      </style>
    `;
    document.body.innerHTML = '<p class="hero">text</p><div class="panel">panel text</div>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] :where(p.hero) {
        color: #c6d0f5 !important;
      }

      html[data-pm-active="true"] :where(div.panel) {
        background-color: #303446 !important;
      }"
    `);
  });
});
