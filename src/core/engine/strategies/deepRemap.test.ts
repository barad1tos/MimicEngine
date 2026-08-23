import { describe, expect, it } from 'vitest';
import { oklchToRgba } from '../../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../../color/parseColor';
import type { SiteSettings } from '../../storage/settingsStore';
import { renderStrategy } from '../../testing/renderStrategy';
import { builtInThemes } from '../../themes';
import { TABLE_VERSION, type StrategyPlan } from '../decisionTable';
import type { AuthoredColorDeclaration, PageFacts, SvgPresentationColor } from '../pageFacts';
import { deepRemap as deepRemapStrategy } from './deepRemap';

const catppuccinFrappe = builtInThemes[0];
const deepRemap = renderStrategy(deepRemapStrategy);

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
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

function facts(
  svgPresentationColors: SvgPresentationColor[] = [],
  inlineStyleColors: AuthoredColorDeclaration[] = [],
): PageFacts {
  return { ...emptyFacts(), svgPresentationColors, inlineStyleColors };
}

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

function anyPlan(): StrategyPlan {
  return {
    provenance: {
      kind: 'auto',
      rule: 'test',
      strategies: ['baseline', 'deepRemap'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    },
  };
}

describe('deepRemap strategy', () => {
  it('returns an empty string when there is nothing to remap', () => {
    const { css } = deepRemap.produce(catppuccinFrappe, anySiteSettings(), emptyFacts(), anyPlan());

    expect(css).toBe('');
  });

  it('emits gated, escaped, !important svg + inline-style rules, svg rules sorted by full rule text', () => {
    // stroke inserted before fill to prove the output order comes from
    // sorting the emitted rule text ('fill' < 'stroke'), not fixture order.
    const pageFacts = facts(
      [
        { attribute: 'stroke', value: '#3a3a44', color: requireColor('#3a3a44') },
        { attribute: 'fill', value: '#101014', color: requireColor('#101014') },
      ],
      [
        {
          selector: 'div.icon',
          property: 'color',
          value: '#f5f5f7',
          color: requireColor('#f5f5f7'),
          bucket: 'text',
          conditions: [],
        },
      ],
    );

    const { css } = deepRemap.produce(catppuccinFrappe, anySiteSettings(), pageFacts, anyPlan());

    expect(css).toBe(
      'html[data-pm-active="true"] :where(:is(svg, svg *)[fill="#101014"]) {\n' +
        '  fill: #414559 !important;\n' +
        '}\n' +
        '\n' +
        'html[data-pm-active="true"] :where(:is(svg, svg *)[stroke="#3a3a44"]) {\n' +
        '  stroke: #414559 !important;\n' +
        '}\n' +
        '\n' +
        'html[data-pm-active="true"] :where(div.icon) {\n' +
        '  color: #c6d0f5 !important;\n' +
        '}',
    );
  });

  it('CSS-escapes " and \\ inside the embedded attribute value', () => {
    const rawValue = 'url("x")\\';
    const pageFacts = facts([
      { attribute: 'fill', value: rawValue, color: { r: 1, g: 2, b: 3, a: 1 } },
    ]);

    const { css } = deepRemap.produce(catppuccinFrappe, anySiteSettings(), pageFacts, anyPlan());

    expect(css).toContain('[fill="url(\\"x\\")\\\\"]');
  });

  it('leaves a brand-chroma svg fill unmapped when preserveBrandColors is true', () => {
    const brandHex = toHex(oklchToRgba({ l: 0.55, c: 0.24, h: 260 }));
    const pageFacts = facts([
      { attribute: 'fill', value: brandHex, color: requireColor(brandHex) },
    ]);

    const { css } = deepRemap.produce(
      catppuccinFrappe,
      anySiteSettings(true),
      pageFacts,
      anyPlan(),
    );

    expect(css).toBe('');
  });

  it('does not emit a translucent inline-style color, even when it is otherwise the only entry', () => {
    const pageFacts = facts(
      [],
      [
        {
          selector: '.scrim',
          property: 'color',
          value: 'rgba(0, 0, 0, 0.5)',
          color: { r: 0, g: 0, b: 0, a: 0.5 },
          bucket: 'text',
          conditions: [],
        },
      ],
    );

    const { css } = deepRemap.produce(catppuccinFrappe, anySiteSettings(), pageFacts, anyPlan());

    expect(css).toBe('');
  });

  it('reports coverage over the union palette (svg + inline-style) vs the guarded mapping', () => {
    const pageFacts = facts([
      { attribute: 'fill', value: '#101014', color: requireColor('#101014') },
    ]);

    const { coverage } = deepRemap.produce(
      catppuccinFrappe,
      anySiteSettings(),
      pageFacts,
      anyPlan(),
    );

    expect(coverage).toEqual({ discovered: 1, mapped: 1, ratio: 1 });
  });
});
