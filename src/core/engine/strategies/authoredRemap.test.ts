import { describe, expect, it } from 'vitest';
import { oklchToRgba } from '../../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../../color/parseColor';
import type { SiteSettings } from '../../storage/settingsStore';
import { builtInThemes } from '../../themes';
import type { AuthoredColorDeclaration, PageFacts } from '../pageFacts';
import { authoredRemap } from './authoredRemap';

const catppuccinFrappe = builtInThemes[0];

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
}

function decl(
  selector: string,
  property: string,
  hex: string,
  bucket: AuthoredColorDeclaration['bucket'] = 'other',
): AuthoredColorDeclaration {
  return { selector, property, value: hex, color: requireColor(hex), bucket };
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

function facts(
  authoredRules: AuthoredColorDeclaration[] = [],
  inlineStyleColors: AuthoredColorDeclaration[] = [],
): PageFacts {
  return { ...emptyFacts(), authoredRules, inlineStyleColors };
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

describe('authoredRemap strategy', () => {
  it('returns an empty string when there are no mappable declarations', () => {
    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), emptyFacts());

    expect(css).toBe('');
  });

  it('emits a grouped, property-sorted, first-appearance-ordered stylesheet', () => {
    const pageFacts = facts([
      decl('.card', 'color', '#f5f5f7', 'text'),
      decl('.card', 'background-color', '#101014', 'background'),
      decl('.header', 'border-color', '#3a3a44', 'border'),
    ]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);

    expect(css).toMatchInlineSnapshot(`
      "html[data-pm-active="true"] .card {
        background-color: #303446 !important;
        color: #c6d0f5 !important;
      }

      html[data-pm-active="true"] .header {
        border-color: #626880 !important;
      }"
    `);
  });

  it('marks every emitted declaration !important', () => {
    const pageFacts = facts([
      decl('.card', 'color', '#f5f5f7', 'text'),
      decl('.card', 'background-color', '#101014', 'background'),
    ]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);
    const declarationLines = css
      .split('\n')
      .filter((line) => line.trimEnd().endsWith(';') && line.includes(':'));

    expect(declarationLines.length).toBeGreaterThan(0);
    expect(declarationLines.every((line) => line.trimEnd().endsWith('!important;'))).toBe(true);
  });

  it('skips --custom-property declarations even when parsed color is present', () => {
    const pageFacts = facts([decl('.card', '--brand-bg', '#101014', 'background')]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);

    expect(css).toBe('');
  });

  it('skips declarations whose color did not parse', () => {
    const pageFacts = facts([
      { selector: '.card', property: 'color', value: 'currentColor', color: null, bucket: 'text' },
    ]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);

    expect(css).toBe('');
  });

  it('orders selector blocks by first-appearance across authoredRules then inlineStyleColors', () => {
    const pageFacts = facts(
      [decl('.second', 'border-color', '#3a3a44', 'border')],
      [decl('.first', 'color', '#f5f5f7', 'text')],
    );

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);
    const selectorOrder = [...css.matchAll(/html\[data-pm-active="true"] (\S+) \{/g)].map(
      (match) => match[1],
    );

    expect(selectorOrder).toEqual(['.second', '.first']);
  });

  it('merges the same selector appearing in both authoredRules and inlineStyleColors into one block', () => {
    const pageFacts = facts(
      [decl('.btn', 'color', '#f5f5f7', 'text')],
      [decl('.btn', 'border-color', '#3a3a44', 'border')],
    );

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);
    const blockCount = [...css.matchAll(/html\[data-pm-active="true"] \.btn \{/g)].length;

    expect(blockCount).toBe(1);
    expect(css).toContain('color:');
    expect(css).toContain('border-color:');
  });

  it('keeps the LAST declaration when the same selector+property repeats (cascade semantics)', () => {
    // #f5f5f7 (lighter, alphabetically later hex) maps to textMuted; #c9c9d1
    // (alphabetically earlier hex) maps to text — see colorMap's weight-desc/
    // hex-asc tie-break with equal weight. Declared in that order so the
    // second (text-token) declaration must win.
    const pageFacts = facts([
      decl('.a', 'color', '#f5f5f7', 'text'),
      decl('.a', 'color', '#c9c9d1', 'text'),
    ]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);
    const colorLines = css.split('\n').filter((line) => line.trim().startsWith('color:'));

    expect(colorLines).toHaveLength(1);
    expect(colorLines[0]).toContain(catppuccinFrappe.tokens.text);
    expect(colorLines[0]).not.toContain(catppuccinFrappe.tokens.textMuted);
  });

  it('sorts declarations within a selector by property, codepoint order', () => {
    const pageFacts = facts([
      decl('.card', 'color', '#f5f5f7', 'text'),
      decl('.card', 'background-color', '#101014', 'background'),
      decl('.card', 'border-color', '#3a3a44', 'border'),
    ]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(), pageFacts);
    const propertyOrder = css
      .split('\n')
      .filter((line) => line.includes(':') && line.trim().endsWith(';'))
      .map((line) => line.trim().split(':')[0]);

    expect(propertyOrder).toEqual(['background-color', 'border-color', 'color']);
  });

  it('skips a brand-chroma accent color when preserveBrandColors is true', () => {
    const brandHex = toHex(oklchToRgba({ l: 0.55, c: 0.24, h: 260 }));
    const pageFacts = facts([decl('.brand', 'background-color', brandHex, 'other')]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(true), pageFacts);

    expect(css).toBe('');
  });

  it('remaps the same brand-chroma accent color when preserveBrandColors is false', () => {
    const brandHex = toHex(oklchToRgba({ l: 0.55, c: 0.24, h: 260 }));
    const pageFacts = facts([decl('.brand', 'background-color', brandHex, 'other')]);

    const css = authoredRemap.produceCss(catppuccinFrappe, anySiteSettings(false), pageFacts);

    expect(css).toContain('.brand');
    expect(css).toContain('background-color:');
  });
});
