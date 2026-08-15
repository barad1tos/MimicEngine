import { describe, expect, it } from 'vitest';
import type { RgbaColor } from '../../color/parseColor';
import { toHex } from '../../color/parseColor';
import { builtInThemes } from '../../themes';
import type { SiteSettings } from '../../storage/settingsStore';
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
    overrides: [],
  };
}

function emptyFacts(): PageFacts {
  return {
    customProperties: [],
    domElementCount: 0,
    shadowRootCount: 0,
    styleSheetCount: 0,
    unreadableStyleSheetCount: 0,
  };
}

const GRAY = (level: number): RgbaColor => ({ r: level, g: level, b: level, a: 1 });

describe('assignTokens', () => {
  it('maps a name-table hit before considering usage', () => {
    const properties = [colorProperty('--sidebar-border', GRAY(100))];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.get('--sidebar-border')).toBe('border');
  });

  it('falls back to usage when the name does not match the table', () => {
    const properties = [
      colorProperty('--x1', GRAY(10), { background: 3, text: 0, border: 0, other: 0 }),
    ];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.get('--x1')).toBe('canvas');
  });

  it('skips usage-fallback ties', () => {
    const properties = [
      colorProperty('--x2', GRAY(20), { background: 2, text: 2, border: 0, other: 0 }),
    ];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.has('--x2')).toBe(false);
  });

  it('skips when other-usage dominates', () => {
    const properties = [
      colorProperty('--x3', GRAY(20), { background: 1, text: 0, border: 0, other: 5 }),
    ];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.has('--x3')).toBe(false);
  });

  it('skips properties with no recorded usage at all', () => {
    const properties = [colorProperty('--x4', GRAY(20))];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.has('--x4')).toBe(false);
  });

  it('never maps a property with a null color', () => {
    const properties = [colorProperty('--sidebar-border', null)];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.has('--sidebar-border')).toBe(false);
  });

  it('orders the surface ladder by luminance ascending for dark mode', () => {
    const properties = [
      colorProperty('--bg-high', GRAY(149)), // relative luminance ~0.30
      colorProperty('--bg-low', GRAY(39)), // relative luminance ~0.02
      colorProperty('--bg-mid', GRAY(89)), // relative luminance ~0.10
    ];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.get('--bg-low')).toBe('canvas');
    expect(assignments.get('--bg-mid')).toBe('surface1');
    expect(assignments.get('--bg-high')).toBe('surface2');
  });

  it('orders the surface ladder by luminance descending for light mode', () => {
    const properties = [
      colorProperty('--bg-high', GRAY(149)),
      colorProperty('--bg-low', GRAY(39)),
      colorProperty('--bg-mid', GRAY(89)),
    ];

    const assignments = assignTokens(properties, 'light');

    expect(assignments.get('--bg-high')).toBe('canvas');
    expect(assignments.get('--bg-mid')).toBe('surface1');
    expect(assignments.get('--bg-low')).toBe('surface2');
  });

  it('tie-breaks equal luminance in the ladder by property name', () => {
    const properties = [
      colorProperty('--bg-zebra', GRAY(50)),
      colorProperty('--bg-alpha', GRAY(50)),
    ];

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.get('--bg-alpha')).toBe('canvas');
    expect(assignments.get('--bg-zebra')).toBe('surface1');
  });

  it('clamps ladder assignments beyond surface3 to surface3', () => {
    const properties = [0, 1, 2, 3, 4].map((index) =>
      colorProperty(`--bg-${index.toString()}`, GRAY(index * 40 + 10)),
    );

    const assignments = assignTokens(properties, 'dark');

    expect(assignments.get('--bg-3')).toBe('surface3');
    expect(assignments.get('--bg-4')).toBe('surface3');
  });
});

describe('variableRemap strategy', () => {
  it('returns an empty string when nothing can be classified', () => {
    const css = variableRemap.produceCss(builtInThemes[0], anySiteSettings(), emptyFacts());

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

    const css = variableRemap.produceCss(builtInThemes[0], anySiteSettings(), facts);

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] {
        --body-text: var(--pm-text) !important;
        --page-bg: var(--pm-canvas) !important;
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

    const css = variableRemap.produceCss(builtInThemes[0], anySiteSettings(), facts);
    const declarationLines = css.split('\n').filter((line) => line.trim().startsWith('--'));

    expect(declarationLines.length).toBeGreaterThan(0);
    expect(declarationLines.every((line) => line.trimEnd().endsWith('!important;'))).toBe(true);
  });
});
