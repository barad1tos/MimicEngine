import { describe, expect, it } from 'vitest';
import type { RgbaColor } from '../../color/parseColor';
import { toHex } from '../../color/parseColor';
import { builtInThemes } from '../../themes';
import type { SiteSettings } from '../../storage/settingsStore';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import type { CustomPropertyFact, CustomPropertyUse, PageFacts } from '../pageFacts';
import { renderStrategy } from '../../testing/renderStrategy';
import { deriveRoleAliases, variableRemap as variableRemapStrategy } from './variableRemap';

const variableRemap = renderStrategy(variableRemapStrategy);

function colorProperty(
  name: string,
  color: RgbaColor | null,
  usage: CustomPropertyFact['usage'] = { background: 0, text: 0, border: 0, other: 0 },
  uses: CustomPropertyUse[] = [],
): CustomPropertyFact {
  return {
    name,
    value: color ? toHex(color) : 'transparent',
    color,
    references: [],
    usage,
    uses,
  };
}

function propertyUse(
  selector: string,
  property: string,
  bucket: CustomPropertyUse['bucket'],
  value = 'var(--shared)',
  conditions: string[] = [],
): CustomPropertyUse {
  return { selector, property, value, bucket, conditions };
}

function aliasProperty(
  name: string,
  value: string,
  references: string[],
  usage: CustomPropertyFact['usage'],
  uses: CustomPropertyUse[],
): CustomPropertyFact {
  return { name, value, color: null, references, usage, uses };
}

function backgroundProperty(name: string, color: RgbaColor | null): CustomPropertyFact {
  return colorProperty(name, color, { background: 1, text: 0, border: 0, other: 0 }, [
    propertyUse('.surface', 'background-color', 'background', `var(${name})`),
  ]);
}

function textProperty(name: string, color: RgbaColor | null): CustomPropertyFact {
  return colorProperty(name, color, { background: 0, text: 1, border: 0, other: 0 }, [
    propertyUse('.label', 'color', 'text', `var(${name})`),
  ]);
}

function borderProperty(name: string, color: RgbaColor | null): CustomPropertyFact {
  return colorProperty(name, color, { background: 0, text: 0, border: 1, other: 0 }, [
    propertyUse('.outlined', 'border-color', 'border', `var(${name})`),
  ]);
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

describe('deriveRoleAliases', () => {
  it('maps a name-table hit before considering usage', () => {
    const properties = [borderProperty('--sidebar-border', GRAY(100))];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-border--sidebar-border')).toBe('var(--pm-border)');
  });

  it('falls back to usage when the name does not match the table', () => {
    const properties = [backgroundProperty('--x1', GRAY(10))];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--x1')).toBe('var(--pm-elevation-0)');
  });

  it('derives every observed role instead of collapsing usage ties', () => {
    const properties = [
      colorProperty('--x2', GRAY(20), { background: 1, text: 1, border: 0, other: 0 }, [
        propertyUse('.surface', 'background-color', 'background', 'var(--x2)'),
        propertyUse('.label', 'color', 'text', 'var(--x2)'),
      ]),
    ];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--x2')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-text--x2')).toBe('var(--pm-text)');
  });

  it('skips when other-usage dominates', () => {
    const properties = [
      colorProperty('--x3', GRAY(20), { background: 0, text: 0, border: 0, other: 1 }, [
        propertyUse('.shadow', 'box-shadow', 'other', 'var(--x3)'),
      ]),
    ];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.size).toBe(0);
  });

  it('skips properties with no recorded usage at all', () => {
    const properties = [colorProperty('--x4', GRAY(20))];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.size).toBe(0);
  });

  it('never maps a property with a null color', () => {
    const properties = [borderProperty('--sidebar-border', null)];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.size).toBe(0);
  });

  it('never maps a translucent custom property, even with a name-table hit', () => {
    // --scrim-bg would otherwise win the canvas slot via CANVAS_FAMILY_PATTERN
    // ("bg"); a translucent scrim (alpha 0.5) must stay unmapped instead.
    const properties = [backgroundProperty('--scrim-bg', { r: 16, g: 20, b: 24, a: 0.5 })];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.size).toBe(0);
  });

  it('orders the surface ladder by luminance ascending for dark mode', () => {
    const properties = [
      backgroundProperty('--bg-high', GRAY(149)), // relative luminance ~0.30
      backgroundProperty('--bg-low', GRAY(39)), // relative luminance ~0.02
      backgroundProperty('--bg-mid', GRAY(89)), // relative luminance ~0.10
    ];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--bg-low')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-bg--bg-mid')).toBe('var(--pm-elevation-1)');
    expect(assignments.get('--pm-bg--bg-high')).toBe('var(--pm-elevation-2)');
  });

  it('orders the surface ladder by luminance descending for light mode', () => {
    const properties = [
      backgroundProperty('--bg-high', GRAY(149)),
      backgroundProperty('--bg-low', GRAY(39)),
      backgroundProperty('--bg-mid', GRAY(89)),
    ];

    const assignments = deriveRoleAliases(properties, 'light', false);

    expect(assignments.get('--pm-bg--bg-high')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-bg--bg-mid')).toBe('var(--pm-elevation-1)');
    expect(assignments.get('--pm-bg--bg-low')).toBe('var(--pm-elevation-2)');
  });

  it('tie-breaks equal luminance in the ladder by property name', () => {
    const properties = [
      backgroundProperty('--bg-zebra', GRAY(50)),
      backgroundProperty('--bg-alpha', GRAY(50)),
    ];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--bg-alpha')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-bg--bg-zebra')).toBe('var(--pm-elevation-1)');
  });

  it('clamps ladder assignments beyond elevation level 3 to level 3', () => {
    const properties = [0, 1, 2, 3, 4].map((index) =>
      backgroundProperty(`--bg-${index.toString()}`, GRAY(index * 40 + 10)),
    );

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--bg-3')).toBe('var(--pm-elevation-3)');
    expect(assignments.get('--pm-bg--bg-4')).toBe('var(--pm-elevation-3)');
  });

  it('gives a canvas-family name priority for the canvas slot over a lighter surface-family entry', () => {
    // Light mode alone would hand the canvas slot to whichever entry has
    // the highest luminance — here that's --card-panel (surface-family
    // pattern). The name-priority rule overrides that: --page-bg is both
    // canvas-family and (via "page") strong-canvas-named, so it wins the
    // canvas slot (elevation 0) regardless, and --card-panel is demoted to
    // elevation 1.
    const properties = [
      backgroundProperty('--card-panel', GRAY(200)),
      backgroundProperty('--page-bg', GRAY(120)),
    ];

    const assignments = deriveRoleAliases(properties, 'light', false);

    expect(assignments.get('--pm-bg--page-bg')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-bg--card-panel')).toBe('var(--pm-elevation-1)');
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
      backgroundProperty('--page-bg', GRAY(200)), // lightest
      backgroundProperty('--card-bg', GRAY(120)), // mid
      backgroundProperty('--panel-bg', GRAY(40)), // darkest — old rule's winner
    ];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-bg--page-bg')).toBe('var(--pm-elevation-0)');
    expect(assignments.get('--pm-bg--panel-bg')).toBe('var(--pm-elevation-1)');
    expect(assignments.get('--pm-bg--card-bg')).toBe('var(--pm-elevation-2)');
  });

  it('excludes a vivid custom property from token assignment entirely when preserveBrandColors is on', () => {
    // Mirrors mapAccent's exemption (colorMap.ts): the brand stays authored,
    // not merely re-pointed at the accent token.
    const properties = [textProperty('--brand', VIVID_BRAND)];

    const assignments = deriveRoleAliases(properties, 'dark', true);

    expect(assignments.size).toBe(0);
  });

  it('assigns the same vivid custom property normally when preserveBrandColors is off', () => {
    const properties = [textProperty('--brand', VIVID_BRAND)];

    const assignments = deriveRoleAliases(properties, 'dark', false);

    expect(assignments.get('--pm-text--brand')).toBe('var(--pm-accent)');
  });

  it('assigns a muted custom property regardless of preserveBrandColors', () => {
    const properties = [borderProperty('--sidebar-border', GRAY(100))];

    expect(deriveRoleAliases(properties, 'dark', true).get('--pm-border--sidebar-border')).toBe(
      'var(--pm-border)',
    );
    expect(deriveRoleAliases(properties, 'dark', false).get('--pm-border--sidebar-border')).toBe(
      'var(--pm-border)',
    );
  });
});

describe('variableRemap strategy', () => {
  it('derives independent aliases when one custom property is used for a surface and text', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--shared', GRAY(240), { background: 1, text: 1, border: 0, other: 0 }, [
          propertyUse('.panel', 'background-color', 'background'),
          propertyUse('.label', 'color', 'text'),
        ]),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).not.toContain('\n  --shared:');
    expect(css).toContain('--pm-bg--shared: var(--pm-elevation-0) !important;');
    expect(css).toContain('--pm-text--shared: var(--pm-text) !important;');
    expect(css).toContain('.panel) {\n  background-color: var(--pm-bg--shared) !important;\n}');
    expect(css).toContain('.label) {\n  color: var(--pm-text--shared) !important;\n}');
  });

  it('propagates a consumer role through a custom-property alias chain', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--source', GRAY(240), {
          background: 0,
          text: 0,
          border: 0,
          other: 1,
        }),
        aliasProperty(
          '--alias',
          'var(--source, #ffffff)',
          ['--source'],
          { background: 0, text: 1, border: 0, other: 0 },
          [propertyUse('.label', 'color', 'text', 'var(--alias, #000000)')],
        ),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toContain('--pm-text--source: var(--pm-text) !important;');
    expect(css).toContain('--pm-text--alias: var(--pm-text--source, #ffffff) !important;');
    expect(css).toContain('color: var(--pm-text--alias, #000000) !important;');
  });

  it('does not emit partial aliases when one dependency is unresolved', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--source', GRAY(240), {
          background: 0,
          text: 0,
          border: 0,
          other: 1,
        }),
        aliasProperty(
          '--alias',
          'color-mix(in srgb, var(--source), var(--missing))',
          ['--source', '--missing'],
          { background: 0, text: 1, border: 0, other: 0 },
          [propertyUse('.label', 'color', 'text', 'var(--alias)')],
        ),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toBe('');
  });

  it('rewrites every variable reference in a conditional consumer', () => {
    const use = propertyUse(
      '.hero',
      'background-image',
      'background',
      'linear-gradient(var(--first), var(--second, var(--first)))',
      ['@media (min-width: 1px)'],
    );
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--first', GRAY(20), { background: 1, text: 0, border: 0, other: 0 }, [use]),
        colorProperty('--second', GRAY(40), { background: 1, text: 0, border: 0, other: 0 }, [use]),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toContain('@media (min-width: 1px)');
    expect(css).toContain(
      'linear-gradient(var(--pm-bg--first), var(--pm-bg--second, var(--pm-bg--first)))',
    );
  });

  it('drops cyclic custom-property alias chains', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        aliasProperty(
          '--first',
          'var(--second)',
          ['--second'],
          { background: 0, text: 1, border: 0, other: 1 },
          [propertyUse('.label', 'color', 'text', 'var(--first)')],
        ),
        aliasProperty(
          '--second',
          'var(--first)',
          ['--first'],
          { background: 0, text: 0, border: 0, other: 1 },
          [],
        ),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toBe('');
  });

  it('keeps a transitive vivid source authored when brand preservation is enabled', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--brand-source', VIVID_BRAND, {
          background: 0,
          text: 0,
          border: 0,
          other: 1,
        }),
        aliasProperty(
          '--alias',
          'var(--brand-source)',
          ['--brand-source'],
          { background: 0, text: 1, border: 0, other: 0 },
          [propertyUse('.brand', 'color', 'text', 'var(--alias)')],
        ),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toBe('');
  });

  it('returns an empty string when nothing can be classified', () => {
    const { css } = variableRemap.produce(
      builtInThemes[0],
      anySiteSettings(),
      emptyFacts(),
      anyPlan(),
    );

    expect(css).toBe('');
  });

  it('emits sorted aliases before their consumer declarations', () => {
    // Names deliberately avoid "brand" — the accent pattern (table index 5)
    // would otherwise win over the background/text patterns (indices 10-11)
    // that this test wants to exercise, per the first-match-wins contract.
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--body-text', GRAY(230), { background: 0, text: 1, border: 0, other: 0 }, [
          propertyUse('body', 'color', 'text', 'var(--body-text)'),
        ]),
        colorProperty('--page-bg', GRAY(20), { background: 1, text: 0, border: 0, other: 0 }, [
          propertyUse('body', 'background-color', 'background', 'var(--page-bg)'),
        ]),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] {
        --pm-bg--page-bg: var(--pm-elevation-0) !important;
        --pm-text--body-text: var(--pm-text) !important;
      }

      html[data-pm-active="true"] :where(body) {
        background-color: var(--pm-bg--page-bg) !important;
        color: var(--pm-text--body-text) !important;
      }"
    `);
  });

  it('marks every emitted declaration !important so it beats inline styles', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--body-text', GRAY(230), { background: 0, text: 1, border: 0, other: 0 }, [
          propertyUse('body', 'color', 'text', 'var(--body-text)'),
        ]),
        colorProperty('--page-bg', GRAY(20), { background: 1, text: 0, border: 0, other: 0 }, [
          propertyUse('body', 'background-color', 'background', 'var(--page-bg)'),
        ]),
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
      customProperties: [
        colorProperty('--brand', VIVID_BRAND, { background: 0, text: 1, border: 0, other: 0 }, [
          propertyUse('.brand', 'color', 'text', 'var(--brand)'),
        ]),
      ],
    };

    const { css } = variableRemap.produce(builtInThemes[0], anySiteSettings(), facts, anyPlan());

    expect(css).toBe('');
  });

  it('remaps the same vivid property when preserveBrandColors is off', () => {
    const facts: PageFacts = {
      ...emptyFacts(),
      customProperties: [
        colorProperty('--brand', VIVID_BRAND, { background: 0, text: 1, border: 0, other: 0 }, [
          propertyUse('.brand', 'color', 'text', 'var(--brand)'),
        ]),
      ],
    };
    const settings: SiteSettings = { ...anySiteSettings(), preserveBrandColors: false };

    const { css } = variableRemap.produce(builtInThemes[0], settings, facts, anyPlan());

    expect(css).toContain('--pm-text--brand: var(--pm-accent) !important;');
    expect(css).toContain('color: var(--pm-text--brand) !important;');
  });
});
