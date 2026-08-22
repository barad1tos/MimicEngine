// @vitest-environment happy-dom
// src/core/engine/strategies/computedFallback.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignatureCensus, installCensus } from '../../analyzer/signatureCensus';
import { contrastRatio } from '../../color/contrast';
import { oklchToRgba } from '../../color/oklch';
import { toHex } from '../../color/parseColor';
import type { SiteSettings } from '../../storage/settingsStore';
import { builtInThemes, type PaletteTheme } from '../../themes';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import { elevationBackgroundHex } from '../elevationScale';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import type { StrategyId } from '../strategyId';
import { computedFallback } from './computedFallback';

const catppuccinFrappe = builtInThemes[0];

function withCanvas(theme: PaletteTheme, canvas: string): PaletteTheme {
  return { ...theme, tokens: { ...theme.tokens, canvas } };
}

function withText(theme: PaletteTheme, text: string, textMuted: string): PaletteTheme {
  return { ...theme, tokens: { ...theme.tokens, text, textMuted } };
}

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

  it('emits distinct elevation-variable backgrounds for the same hex at different elevations, and casts a shadow only on the raised island', () => {
    // .card's box-shadow is the real elevation boundary here: same hex as
    // .ground alone would now fold onto one visual surface (elevation 0
    // for both) — the shadow is what makes .card a genuinely distinct
    // surface at elevation 1. Both backgrounds render as `var(--pm-elevation-N)`
    // (the "render-time" substitution — ColorMapping itself still stored real
    // hexes, contrast math already ran against them); only .card, the
    // elevation >= 1 island, additionally gets `box-shadow: var(--pm-shadow-1)`
    // in the SAME rule block — the ground rung stays flat.
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
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

    const groundBlock = /:where\(div\.ground\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const cardBlock = /:where\(div\.card\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const groundBackground = /background-color: (var\(--pm-elevation-\d\))/.exec(groundBlock)?.[1];
    const cardBackground = /background-color: (var\(--pm-elevation-\d\))/.exec(cardBlock)?.[1];

    expect(groundBackground).toBe('var(--pm-elevation-0)');
    expect(cardBackground).toBe('var(--pm-elevation-1)');
    expect(groundBlock).not.toContain('box-shadow');
    expect(cardBlock).toContain('box-shadow: var(--pm-shadow-1) !important;');
  });

  it('labels a level-3 census declaration correctly even when the theme ramp collides its hex with level 1 (post-review fix: no more reverse hex->level lookup)', () => {
    // This theme's ramp is a genuine collision (pinned in elevationScale.test.ts's
    // own bounce-cascade coverage): level 1 and level 3 render the IDENTICAL
    // hex (Amendment 3.5's adjacent-contrast bounce), while level 2 is
    // distinct. Before the fix, substituteElevationBackgrounds resolved the
    // var() name via elevationLevelForHex — a linear hex->level scan that
    // resolves any collision first-wins — so a level-3 declaration whose
    // mapped hex collided with level 1 was mislabeled `--pm-elevation-1`
    // (same rendered color, wrong provenance). The fix reads
    // declaration.elevation directly instead of searching for it.
    const collisionTheme = withText(withCanvas(catppuccinFrappe, '#101a3a'), '#f5f5f5', '#c8c8c8');
    expect(elevationBackgroundHex(collisionTheme, 1)).toBe(
      elevationBackgroundHex(collisionTheme, 3),
    );
    expect(elevationBackgroundHex(collisionTheme, 2)).not.toBe(
      elevationBackgroundHex(collisionTheme, 3),
    );

    // Three nested shadow boundaries put .deep at elevation 3; every ancestor
    // shares the same raw hex, so the ONLY thing distinguishing their levels
    // is the census's own stacking-depth tracking, not the sampled color.
    document.head.innerHTML = `
      <style>
        .l0 { background-color: rgb(200, 200, 200); }
        .l1 { background-color: rgb(200, 200, 200); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
        .l2 { background-color: rgb(200, 200, 200); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
        .deep { background-color: rgb(200, 200, 200); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="l0"><div class="l1"><div class="l2"><div class="deep">x</div></div></div></div>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      collisionTheme,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const deepBlock = /:where\(div\.deep\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const l1Block = /:where\(div\.l1\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const deepBackground = /background-color: (var\(--pm-elevation-\d\))/.exec(deepBlock)?.[1];
    const l1Background = /background-color: (var\(--pm-elevation-\d\))/.exec(l1Block)?.[1];

    expect(deepBackground).toBe('var(--pm-elevation-3)');
    expect(l1Background).toBe('var(--pm-elevation-1)');
    expect(deepBlock).toContain('box-shadow: var(--pm-shadow-3) !important;');
  });

  it('keeps the paired guard operating on real hexes when the paired background is elevation-ramped (var-substituted only at render time)', () => {
    // .card's own background is low-chroma (not accent-classified), so it
    // goes through the ladder and renders as `var(--pm-elevation-N)` in the
    // final CSS -- but guardContrast/pairedTextOverride ran their contrast
    // math against the underlying HEX before that substitution happened. If
    // either ever compared against the literal string "var(--pm-elevation-N)"
    // instead, contrastRatio would fail to parse it and silently skip the
    // repair, and this assertion would fail.
    const cardBackgroundHex = toHex(oklchToRgba({ l: 0.5, c: 0.02, h: 250 }));
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(48, 52, 70); }
        .card {
          background-color: ${cardBackgroundHex};
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
          color: rgb(60, 60, 70);
        }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><div class="card">x</div></div>';
    censusFromCurrentDom();

    const first = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    ).css;
    const second = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    ).css;
    expect(second).toBe(first);

    const cardBlock = /:where\(div\.card\) \{[^}]*\}/.exec(first)?.[0] ?? '';
    const background = /background-color: (var\(--pm-elevation-\d\))/.exec(cardBlock)?.[1];
    const text = /(?<!background-)color: (#\w{6})/.exec(cardBlock)?.[1];
    expect(background).toBeDefined();
    expect(text).toBeDefined();
    if (background === undefined || text === undefined)
      throw new Error('expected both a var() background and a hex text color');

    const level = Number(/--pm-elevation-(\d)/.exec(background)?.[1]);
    const resolvedBackgroundHex = elevationBackgroundHex(catppuccinFrappe, level);
    expect(contrastRatio(text, resolvedBackgroundHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('counts a same-hex, different-elevation background pair as ONE mapped color', () => {
    // Same fixture as the elevation-surface-token test above: .ground and
    // .card share a raw hex but occupy different elevation-keyed mapping
    // entries, so they emit two distinct rules. Coverage measures COLORS,
    // not rules — the census only ever saw one distinct raw hex (both
    // declarations share the literal string "rgb(255, 255, 255)"), so
    // `discovered` must stay 1, and `mapped` must also collapse back to 1
    // (the raw-hex-deduped count of entries with at least one composite key
    // present in the mapping), not 2 (the composite-key count). Asserting
    // the full object, not just `mapped`, is deliberate: `discovered: 1,
    // mapped: 2` would still satisfy `mapped === 2` while producing a
    // nonsensical >100% ratio in the popup.
    // .card's box-shadow is the real elevation boundary here: same hex as
    // .ground alone would now fold onto one visual surface (elevation 0
    // for both) — the shadow is what makes .card a genuinely distinct
    // surface at elevation 1.
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
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

    expect(coverage).toEqual({ discovered: 1, mapped: 1, ratio: 1 });
  });

  it('counts two different mapped backgrounds as two mapped colors', () => {
    // Control case for the same-hex collapse above: two genuinely distinct
    // hexes, each mapped, must still count as two — the raw-hex dedupe in
    // mappedHexCount must not under-count when there is no collision to
    // collapse.
    document.head.innerHTML = `
      <style>
        .a { background-color: rgb(20, 30, 40); }
        .b { background-color: rgb(90, 100, 110); }
      </style>
    `;
    document.body.innerHTML = '<div class="a">x</div><div class="b">y</div>';
    censusFromCurrentDom();

    const { coverage } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    expect(coverage).toEqual({ discovered: 2, mapped: 2, ratio: 1 });
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
        background-color: var(--pm-elevation-0) !important;
      }"
    `);
  });

  it('overrides a signature text color that fails contrast against its own mapped background', () => {
    // Accent-ish saturated background + near-white text: after remap the pair
    // must be readable — the emitted color for .pill must NOT be the plain
    // text mapping if it fails 4.5:1 against .pill's mapped background.
    document.head.innerHTML = `
      <style>
        .pill { background-color: rgb(1, 117, 79); color: rgb(244, 244, 244); }
      </style>
    `;
    document.body.innerHTML = '<span class="pill">All</span>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const block = /:where\(span\.pill\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const bg = /background-color: (#\w{6})/.exec(block)?.[1];
    const text = /(?<!background-)color: (#\w{6})/.exec(block)?.[1];
    expect(bg).toBeDefined();
    expect(text).toBeDefined();
    if (bg === undefined || text === undefined) throw new Error('expected both bg and text');
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves a readable pair's text color identical to the plain text-bucket mapping", () => {
    // .card maps to theme surface+text which already clears 4.5:1 — no
    // override should fire. Proven via a control comparison: the SAME text
    // declaration, censused WITHOUT any background declaration at all (a
    // separate DOM/census pair), has no background to pair against, so its
    // emitted color is necessarily the plain text-bucket mapping. If the
    // paired guard is truly a no-op here, the with-background run must emit
    // that exact same hex for .card's text.
    document.head.innerHTML = `
      <style>
        .card { background-color: rgb(255, 255, 255); color: rgb(20, 20, 20); }
      </style>
    `;
    document.body.innerHTML = '<div class="card">text</div>';
    censusFromCurrentDom();

    const { css: withBackground } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    installCensus(null);
    document.head.innerHTML = `
      <style>
        .card { color: rgb(20, 20, 20); }
      </style>
    `;
    document.body.innerHTML = '<div class="card">text</div>';
    censusFromCurrentDom();

    const { css: control } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const withBackgroundText = /(?<!background-)color: (#\w{6})/.exec(withBackground)?.[1];
    const controlText = /(?<!background-)color: (#\w{6})/.exec(control)?.[1];
    expect(withBackgroundText).toBeDefined();
    expect(controlText).toBeDefined();
    expect(withBackgroundText).toBe(controlText);
  });

  it('produces byte-identical css across repeated runs, with the fired override still passing on the second run', () => {
    // Same accent-pair fixture as the override test above, called twice from
    // the SAME installed census. Pins the fired-override path against a
    // Map/iteration-order regression: an implementation that built
    // mappedBackgroundBySelector (or any of the resolved-declaration bookkeeping)
    // without stable ordering could pass once and diverge on a second call
    // with identical inputs — this would slip through a single-run assertion.
    document.head.innerHTML = `
      <style>
        .pill { background-color: rgb(1, 117, 79); color: rgb(244, 244, 244); }
      </style>
    `;
    document.body.innerHTML = '<span class="pill">All</span>';
    censusFromCurrentDom();

    const first = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    ).css;
    const second = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    ).css;

    expect(second).toBe(first);

    const block = /:where\(span\.pill\) \{[^}]*\}/.exec(second)?.[0] ?? '';
    const bg = /background-color: (#\w{6})/.exec(block)?.[1];
    const text = /(?<!background-)color: (#\w{6})/.exec(block)?.[1];
    expect(bg).toBeDefined();
    expect(text).toBeDefined();
    if (bg === undefined || text === undefined) throw new Error('expected both bg and text');
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("overrides only the selector whose own pair fails contrast, leaving a sibling selector's mapping untouched", () => {
    // Two selectors on the SAME page/census: .pill's own pair fails 4.5:1
    // (override must fire) and .plain's own pair already clears it (no
    // override needed). Proves mappedBackgroundBySelector is genuinely keyed
    // per-selector: if .plain's lookup ever leaked .pill's mapped background
    // instead of its own, .plain's plain text-bucket mapping (the theme's own
    // `text` token, #c6d0f5 for catppuccinFrappe) would itself fail contrast
    // against .pill's mapped background (that exact pair — text token vs
    // .pill's accent-mapped background — is the same failing pair the
    // override test above measures at ~1.14:1) and get overridden away from
    // the theme's raw text token.
    document.head.innerHTML = `
      <style>
        .pill { background-color: rgb(1, 117, 79); color: rgb(244, 244, 244); }
        .plain { background-color: rgb(255, 255, 255); color: rgb(20, 20, 20); }
      </style>
    `;
    document.body.innerHTML = '<span class="pill">All</span><div class="plain">text</div>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const pillBlock = /:where\(span\.pill\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const pillBg = /background-color: (#\w{6})/.exec(pillBlock)?.[1];
    const pillText = /(?<!background-)color: (#\w{6})/.exec(pillBlock)?.[1];
    expect(pillBg).toBeDefined();
    expect(pillText).toBeDefined();
    if (pillBg === undefined || pillText === undefined)
      throw new Error('expected both bg and text for .pill');
    expect(contrastRatio(pillText, pillBg)).toBeGreaterThanOrEqual(4.5);

    const plainBlock = /:where\(div\.plain\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const plainText = /(?<!background-)color: (#\w{6})/.exec(plainBlock)?.[1];
    expect(plainText).toBeDefined();
    expect(plainText).toBe(catppuccinFrappe.tokens.text);
  });

  it('checks a preserved brand background instead of skipping the paired guard (C-1)', () => {
    // preserveBrandColors=true (the default) makes partitionAccents
    // (colorMap.ts) leave this high-chroma background OUT of `mapping`
    // entirely -- true preservation, not a missing case. Before the fix,
    // an unmapped background declaration had no entry in the paired guard's
    // selector->background lookup, so the guard skipped this selector
    // outright and its text got the plain global text-bucket mapping with
    // no check against the color the background actually stays: a red badge
    // keeps #ff0000, and black text remapped straight to the theme's text
    // token (#c6d0f5) clashes with it (2.62:1, per the Codex report).
    document.head.innerHTML = `
      <style>
        .badge { background-color: rgb(255, 0, 0); color: rgb(0, 0, 0); }
      </style>
    `;
    document.body.innerHTML = '<span class="badge">New</span>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      catppuccinFrappe,
      anySiteSettings(true),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const block = /:where\(span\.badge\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    // Preserved means untouched: no background rule is ever emitted for it.
    expect(block).not.toContain('background-color');

    const text = /(?<!background-)color: (#\w{6})/.exec(block)?.[1];
    expect(text).toBeDefined();
    if (text === undefined) throw new Error('expected a text color');
    expect(contrastRatio(text, '#ff0000')).toBeGreaterThanOrEqual(4.5);
  });

  it('repairs the better-of-two pick against the ACTUAL paired background when both theme tokens fail (C-2)', () => {
    // An imported theme's own canvas/text pair only ever gets validated
    // against EACH OTHER (8.06:1 here) -- never against an arbitrary
    // background a signature happens to sit on. This custom theme's own
    // `accent` token (#969696) fails 4.5:1 against BOTH canvas (4.16:1) and
    // text (1.94:1): the pre-fix "better of two" pick (canvas, the higher of
    // the two) would ship a candidate that still fails. .page/.wrapper give
    // canvas the page's dominant (highest-weight) background so
    // guardContrast's own GLOBAL text repair validates against canvas, not
    // .badge's own paired background -- only computedFallback's per-selector
    // paired guard ever checks .badge's actual pairing.
    const customTheme: PaletteTheme = {
      id: 'custom-imported-c2',
      name: 'Custom Imported',
      mode: 'dark',
      tokens: {
        canvas: '#303446',
        surface1: '#414559',
        surface2: '#51576d',
        surface3: '#626880',
        text: '#c6d0f5',
        textMuted: '#a5adce',
        border: '#626880',
        accent: '#969696',
        link: '#00ff00',
        success: '#00ffff',
        warning: '#0000ff',
        danger: '#ff00ff',
        selection: '#51576d',
        focus: '#babbf1',
      },
    };
    // Chroma ~0.10: accent-classified (ACCENT_CHROMA_THRESHOLD is 0.09) but
    // below BRAND_CHROMA_THRESHOLD (0.14), so preserveBrandColors does NOT
    // preserve it -- mapAccent resolves it to the nearest accent-family
    // token by hue, and hue 0 matches this theme's achromatic `accent`
    // token (hue 0 by convention), so it lands there.
    const badgeHex = toHex(oklchToRgba({ l: 0.5, c: 0.1, h: 0 }));

    document.head.innerHTML = `
      <style>
        .page { background-color: rgb(48, 52, 70); color: rgb(198, 208, 245); }
        .wrapper { background-color: rgb(48, 52, 70); color: rgb(198, 208, 245); }
        .badge { background-color: ${badgeHex}; color: rgb(198, 208, 245); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="page">A</div><div class="wrapper">B</div><span class="badge">C</span>';
    censusFromCurrentDom();

    const { css } = computedFallback.produce(
      customTheme,
      anySiteSettings(true),
      emptyFacts(),
      planWithoutAuthoredRemap,
    );

    const block = /:where\(span\.badge\) \{[^}]*\}/.exec(css)?.[0] ?? '';
    const bg = /background-color: (#\w{6})/.exec(block)?.[1];
    const text = /(?<!background-)color: (#\w{6})/.exec(block)?.[1];
    expect(bg).toBeDefined();
    expect(text).toBeDefined();
    if (bg === undefined || text === undefined) throw new Error('expected both bg and text');
    expect(bg).toBe('#969696');
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
