// @vitest-environment happy-dom
// src/core/engine/strategies/computedFallback.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignatureCensus, installCensus } from '../../analyzer/signatureCensus';
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

// Builds a census over the current document and installs it, the same way
// pageThemeController installs its live census before invoking the plan.
// Every test that needs computedFallback to see sampled colors
// calls this after setting up its DOM fixture.
function censusFromCurrentDom(): void {
  const census = createSignatureCensus();
  census.begin(document);
  while (!census.advance(1000)) {
    /* drain */
  }
  installCensus(census);
}

beforeEach(() => {
  // happy-dom's layout engine always reports zero-size rects; stub it so
  // the census' visibility filter lets our fixture elements through, same
  // as any real, laid-out page element would be.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(VISIBLE_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
  installCensus(null);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('computedFallback strategy', () => {
  it('emits nothing when no census is installed', () => {
    document.body.innerHTML = '<p class="hero">text</p>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('does not fall back to sampling the live DOM when no census is installed (styled fixture)', () => {
    // Unlike the test above, this fixture IS styled — an unstyled fixture
    // can't tell "no census installed" apart from "produce silently walked
    // the live DOM instead", because happy-dom's computed styles are empty
    // either way. A styled fixture makes the two paths observably different:
    // if produce ever fell back to a fresh DOM walk when installedCensus()
    // is null, this would emit a rule for .hero. It must not — no census
    // installed means no coverage, period.
    document.head.innerHTML = '<style>.hero { color: rgb(20, 30, 40); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('reads the installed snapshot, not the live DOM, after the DOM has since mutated', () => {
    // Census the DOM in state A (one styled element), install it, then
    // mutate the DOM to add a second, differently-colored styled element
    // WITHOUT re-censusing (no ingestAddedElements call). produce must keep
    // emitting from the snapshot it was handed, not re-derive coverage from
    // whatever the live document looks like by the time it runs.
    document.head.innerHTML = '<style>.hero { color: rgb(20, 30, 40); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';
    censusFromCurrentDom();

    document.head.innerHTML += '<style>.late { color: rgb(90, 100, 110); }</style>';
    document.body.innerHTML += '<div class="late">late text</div>';

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(css).toContain(':where(p.hero)');
    expect(css).not.toContain('.late');
  });

  it('returns an empty string when the installed census is empty', () => {
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('does not re-emit a sampled color already covered by authored facts', () => {
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';
    censusFromCurrentDom();

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
    censusFromCurrentDom();

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
    // isOpaque gates what enters collectAuthoredHexes, same as the pipeline
    // gate that decides what enters toNovelDeclarations in the first place.
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';
    censusFromCurrentDom();

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
    censusFromCurrentDom();

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
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithAuthoredRemap,
    );

    expect(css).toBe('');
  });

  it('samples and remaps a border-bottom divider', () => {
    document.head.innerHTML = `
      <style>
        .divider { border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: rgb(200, 200, 200); }
      </style>
    `;
    document.body.innerHTML = '<div class="divider"></div>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(css).toContain('html[data-pm-active="true"] :where(div.divider) {');
    expect(css).toContain('border-color:');
  });

  it('coverage denominator counts census-seen colors, not just mapped ones', () => {
    // .a maps; .c diverges (dropped) — discovered must still count c's colors.
    document.head.innerHTML = `
      <style>
        .a { color: rgb(20, 30, 40); }
        .light .c { color: rgb(50, 60, 70); }
        .dark .c { color: rgb(200, 210, 220); }
      </style>
    `;
    document.body.innerHTML = `
      <p class="a">x</p>
      <div class="light"><i class="c">y</i></div>
      <div class="dark"><i class="c">z</i></div>
    `;
    censusFromCurrentDom();

    const { coverage } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(coverage?.discovered).toBeGreaterThanOrEqual(3);
  });

  it('excludes authored-covered colors from the coverage denominator when the stoplist is active', () => {
    // A fully-themed, mixed-visibility page: the only color the census sees
    // is already covered by authored analysis. Before this fix, the
    // denominator was distinctColorsSeen (every opaque census value,
    // authored-covered or not) — summed with authoredRemap's own report in
    // aggregateCoverage, that double-counted this color and could report a
    // fully-themed page at ~50%. The census side of this page must
    // contribute 0/0: nothing left over for computedFallback to discover.
    document.head.innerHTML = '<style>.hero { color: rgb(255, 0, 0); }</style>';
    document.body.innerHTML = '<p class="hero">text</p>';
    censusFromCurrentDom();

    const facts = factsWithAuthoredRule({
      selector: '.hero',
      property: 'color',
      value: '#ff0000',
      color: { r: 255, g: 0, b: 0, a: 1 },
      bucket: 'text',
      conditions: [],
    });

    const { coverage } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      facts,
      planWithAuthoredRemap,
    );

    expect(coverage).toEqual({ discovered: 0, mapped: 0, ratio: 0 });
  });

  it('emits different surface tokens for the same hex at different elevations', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><div class="card">x</div></div>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const groundRule = /:where\(div\.ground\) \{[^}]*background-color: (#\w{6})/.exec(css)?.[1];
    const cardRule = /:where\(div\.card\) \{[^}]*background-color: (#\w{6})/.exec(css)?.[1];
    expect(groundRule).toBeDefined();
    expect(cardRule).toBeDefined();
    expect(groundRule).not.toBe(cardRule);
  });

  it('counts both same-hex, different-elevation backgrounds as mapped in coverage', () => {
    // Same fixture as the elevation-surface-token test above: .ground and
    // .card share a raw hex but occupy different elevation-keyed mapping
    // entries. mappedCount must resolve each via mappingKeyOf, not the plain
    // hex — otherwise the second entry's lookup silently misses and coverage
    // undercounts an elevation-bearing background that the CSS output above
    // proves was actually mapped and emitted.
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><div class="card">x</div></div>';
    censusFromCurrentDom();

    const { coverage } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(coverage?.mapped).toBe(2);
  });

  it('snapshot: emits a grouped stylesheet from novel sampled colors', () => {
    document.head.innerHTML = `
      <style>
        .hero { color: rgb(20, 30, 40); }
        .panel { background-color: rgb(200, 210, 220); }
      </style>
    `;
    document.body.innerHTML = '<p class="hero">text</p><div class="panel">panel text</div>';
    censusFromCurrentDom();

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
