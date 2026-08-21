import { describe, expect, it } from 'vitest';
import type { RgbaColor } from '../../color/parseColor';
import { toHex } from '../../color/parseColor';
import { builtInThemes } from '../../themes';
import type { SiteSettings } from '../../storage/settingsStore';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import type { CustomPropertyFact, PageFacts } from '../pageFacts';
import { assignTokens, variableRemap } from './variableRemap';

function colorProperty(
  name: string,
  color: RgbaColor | null,
  usage: CustomPropertyFact['usage'] = { background: 0, text: 0, border: 0, other: 0 },
): CustomPropertyFact {
  return { name, value: color ? toHex(color) : 'transparent', color, usage };
}

function anySiteSettings(): SiteSettings {
  return {
    enabled: true,
    themeId: 'placeholder-theme',
    strategy: 'auto',
    preserveImages: true,
    preserveBrandColors: true,
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

function anyPlan(): StrategyPlan {
  return {
    provenance: {
      kind: 'auto',
      rule: 'test',
      strategies: ['baseline', 'variableRemap', 'authoredRemap', 'computedFallback'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    },
  };
}

const GRAY = (level: number): RgbaColor => ({ r: level, g: level, b: level, a: 1 });

// Vivid enough to clear BRAND_CHROMA_THRESHOLD (0.14) in colorMap.ts.
const VIVID_BRAND: RgbaColor = { r: 255, g: 68, b: 0, a: 1 };

describe('assignTokens', () => {
  it('maps a name-table hit before considering usage', () => {
    const properties = [colorProperty('--sidebar-border', GRAY(100))];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--sidebar-border')).toBe('border');
  });

  it('falls back to usage when the name does not match the table', () => {
    const properties = [
      colorProperty('--x1', GRAY(10), { background: 3, text: 0, border: 0, other: 0 }),
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--x1')).toBe(0);
  });

  it('skips usage-fallback ties', () => {
    const properties = [
      colorProperty('--x2', GRAY(20), { background: 2, text: 2, border: 0, other: 0 }),
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.has('--x2')).toBe(false);
  });

  it('skips when other-usage dominates', () => {
    const properties = [
      colorProperty('--x3', GRAY(20), { background: 1, text: 0, border: 0, other: 5 }),
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.has('--x3')).toBe(false);
  });

  it('skips properties with no recorded usage at all', () => {
    const properties = [colorProperty('--x4', GRAY(20))];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.has('--x4')).toBe(false);
  });

  it('never maps a property with a null color', () => {
    const properties = [colorProperty('--sidebar-border', null)];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.has('--sidebar-border')).toBe(false);
  });

  it('never maps a translucent custom property, even with a name-table hit', () => {
    // --scrim-bg would otherwise win the canvas slot via CANVAS_FAMILY_PATTERN
    // ("bg"); a translucent scrim (alpha 0.5) must stay unmapped instead.
    const properties = [colorProperty('--scrim-bg', { r: 16, g: 20, b: 24, a: 0.5 })];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.has('--scrim-bg')).toBe(false);
  });

  it('orders the surface ladder by luminance ascending for dark mode', () => {
    const properties = [
      colorProperty('--bg-high', GRAY(149)), // relative luminance ~0.30
      colorProperty('--bg-low', GRAY(39)), // relative luminance ~0.02
      colorProperty('--bg-mid', GRAY(89)), // relative luminance ~0.10
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--bg-low')).toBe(0);
    expect(assignments.get('--bg-mid')).toBe(1);
    expect(assignments.get('--bg-high')).toBe(2);
  });

  it('orders the surface ladder by luminance descending for light mode', () => {
    const properties = [
      colorProperty('--bg-high', GRAY(149)),
      colorProperty('--bg-low', GRAY(39)),
      colorProperty('--bg-mid', GRAY(89)),
    ];

    const assignments = assignTokens(properties, 'light', false);

    expect(assignments.get('--bg-high')).toBe(0);
    expect(assignments.get('--bg-mid')).toBe(1);
    expect(assignments.get('--bg-low')).toBe(2);
  });

  it('tie-breaks equal luminance in the ladder by property name', () => {
    const properties = [
      colorProperty('--bg-zebra', GRAY(50)),
      colorProperty('--bg-alpha', GRAY(50)),
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--bg-alpha')).toBe(0);
    expect(assignments.get('--bg-zebra')).toBe(1);
  });

  it('clamps ladder assignments beyond elevation level 3 to level 3', () => {
    const properties = [0, 1, 2, 3, 4].map((index) =>
      colorProperty(`--bg-${index.toString()}`, GRAY(index * 40 + 10)),
    );

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--bg-3')).toBe(3);
    expect(assignments.get('--bg-4')).toBe(3);
  });

  it('gives a canvas-family name priority for the canvas slot over a lighter surface-family entry', () => {
    // Light mode alone would hand the canvas slot to whichever entry has
    // the highest luminance — here that's --card-panel (surface-family
    // pattern). The name-priority rule overrides that: --page-bg is both
    // canvas-family and (via "page") strong-canvas-named, so it wins the
    // canvas slot (elevation 0) regardless, and --card-panel is demoted to
    // elevation 1.
    const properties = [
      colorProperty('--card-panel', GRAY(200)),
      colorProperty('--page-bg', GRAY(120)),
    ];

    const assignments = assignTokens(properties, 'light', false);

    expect(assignments.get('--page-bg')).toBe(0);
    expect(assignments.get('--card-panel')).toBe(1);
  });

  it('gives strong-named entries (page/body/canvas) priority over other *-bg siblings', () => {
    // Real pages: --page-bg, --panel-bg, --card-bg all end in "-bg", so all
    // three match the broad canvas-family pattern and, before this rule,
    // pure luminance decided among them — the darkest (--panel-bg) would
    // win the canvas slot even though --page-bg is the one actually named
    // as the page. --page-bg's name contains "page" as a whole word (strong
    // canvas pattern), so it wins the canvas slot (elevation 0) here despite
    // NOT being the darkest entry in dark mode, where darkest normally wins.
    const properties = [
      colorProperty('--page-bg', GRAY(200)), // lightest
      colorProperty('--card-bg', GRAY(120)), // mid
      colorProperty('--panel-bg', GRAY(40)), // darkest — old rule's winner
    ];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--page-bg')).toBe(0);
    expect(assignments.get('--panel-bg')).toBe(1);
    expect(assignments.get('--card-bg')).toBe(2);
  });

  it('excludes a vivid custom property from token assignment entirely when preserveBrandColors is on', () => {
    // Mirrors mapAccent's exemption (colorMap.ts): the brand stays authored,
    // not merely re-pointed at the accent token.
    const properties = [colorProperty('--brand', VIVID_BRAND)];

    const assignments = assignTokens(properties, 'dark', true);

    expect(assignments.has('--brand')).toBe(false);
  });

  it('assigns the same vivid custom property normally when preserveBrandColors is off', () => {
    const properties = [colorProperty('--brand', VIVID_BRAND)];

    const assignments = assignTokens(properties, 'dark', false);

    expect(assignments.get('--brand')).toBe('accent');
  });

  it('assigns a muted custom property regardless of preserveBrandColors', () => {
    const properties = [colorProperty('--sidebar-border', GRAY(100))];

    expect(assignTokens(properties, 'dark', true).get('--sidebar-border')).toBe('border');
    expect(assignTokens(properties, 'dark', false).get('--sidebar-border')).toBe('border');
  });
});

describe('variableRemap strategy', () => {
  it('returns an empty string when nothing can be classified', () => {
    const { css } = variableRemap.produce(
      builtInThemes[0],
      anySiteSettings(),
      emptyFacts(),
      anyPlan(),
    );

    expect(css).toBe('');
  });

  it('emits one rule with properties sorted by name', () => {
    // Names deliberately avoid "brand" — the accent pattern (table index 5)
    // would otherwise win over the background/text patterns (indices 10-11)
    // that this test wants to exercise, per the first-match-wins contract.
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--body-text', GRAY(230)),
        colorProperty('--page-bg', GRAY(20)),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] {
        --body-text: var(--pm-text) !important;
        --page-bg: var(--pm-elevation-0) !important;
      }"
    `);
  });

  it('marks every emitted declaration !important so it beats inline styles', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--body-text', GRAY(230)),
        colorProperty('--page-bg', GRAY(20)),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());
    const declarationLines = css.split('\n').filter((line) => line.trim().startsWith('--'));

    expect(declarationLines.length).toBeGreaterThan(0);
    expect(declarationLines.every((line) => line.trimEnd().endsWith('!important;'))).toBe(true);
  });

  it('honors preserveBrandColors from site settings, leaving a vivid property unmapped', () => {
    // anySiteSettings() sets preserveBrandColors: true; a single vivid
    // property with nothing else to classify must produce no CSS at all.
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [colorProperty('--brand', VIVID_BRAND)],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toBe('');
  });

  it('remaps the same vivid property when preserveBrandColors is off', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [colorProperty('--brand', VIVID_BRAND)],
    };
    const settings: SiteSettings = { ...anySiteSettings(), preserveBrandColors: false };

    const { css } = variableRemap.produce(builtInThemes[0], settings, facts, anyPlan());

    expect(css).toContain('--brand: var(--pm-accent) !important;');
  });
});
