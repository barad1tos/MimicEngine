// src/core/engine/colorMap.test.ts
import { describe, expect, it } from 'vitest';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import { buildColorMapping, extractSitePalette, type SitePaletteEntry } from './colorMap';
import type { AuthoredColorDeclaration, PageFacts } from './pageFacts';

const catppuccinFrappe = builtInThemes[0];

type PaletteBucket = AuthoredColorDeclaration['bucket'];

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
}

function oklchOf(hex: string): Oklch {
  return rgbaToOklch(requireColor(hex));
}

function decl(
  hex: string,
  bucket: PaletteBucket,
  property = 'color',
  selector = '.el',
): AuthoredColorDeclaration {
  return { selector, property, value: hex, color: parseCssColor(hex), bucket };
}

function makeFacts(
  authoredRules: AuthoredColorDeclaration[],
  inlineStyleColors: AuthoredColorDeclaration[] = [],
): PageFacts {
  return {
    customProperties: [],
    authoredRules,
    inlineStyleColors,
    domElementCount: 0,
    shadowRootCount: 0,
    styleSheetCount: 0,
    unreadableStyleSheetCount: 0,
  };
}

function entry(hex: string, bucket: PaletteBucket, weight = 1): SitePaletteEntry {
  return { hex, color: requireColor(hex), weight, bucket };
}

describe('extractSitePalette', () => {
  it('dedupes by hex; weight = occurrence count across both source arrays', () => {
    const facts = makeFacts(
      [decl('#112233', 'background'), decl('#112233', 'background')],
      [decl('#112233', 'text')],
    );

    const palette = extractSitePalette(facts);

    expect(palette).toHaveLength(1);
    expect(palette[0]).toMatchObject({ hex: '#112233', weight: 3 });
  });

  it('breaks dominant-bucket ties using background > text > border > other', () => {
    const facts = makeFacts([
      decl('#445566', 'text'),
      decl('#445566', 'border'),
      decl('#445566', 'background'),
    ]);

    const [winner] = extractSitePalette(facts);

    expect(winner?.bucket).toBe('background');
  });

  it('breaks a border/other tie in favor of border', () => {
    const facts = makeFacts([decl('#778899', 'other'), decl('#778899', 'border')]);

    const [winner] = extractSitePalette(facts);

    expect(winner?.bucket).toBe('border');
  });

  it('picks the bucket with the strict majority even without a tie', () => {
    const facts = makeFacts([
      decl('#a1a1a1', 'text'),
      decl('#a1a1a1', 'text'),
      decl('#a1a1a1', 'border'),
    ]);

    const [winner] = extractSitePalette(facts);

    expect(winner?.bucket).toBe('text');
  });

  it('sorts by weight desc, then hex asc (codepoint order)', () => {
    const facts = makeFacts([
      decl('#bbbbbb', 'other'),
      decl('#aaaaaa', 'other'),
      decl('#aaaaaa', 'other'),
    ]);

    const palette = extractSitePalette(facts);

    expect(palette.map((item) => item.hex)).toEqual(['#aaaaaa', '#bbbbbb']);
  });

  it('breaks equal-weight ties by ascending hex, not localeCompare', () => {
    const facts = makeFacts([decl('#cccccc', 'other'), decl('#000000', 'other')]);

    const palette = extractSitePalette(facts);

    expect(palette.map((item) => item.hex)).toEqual(['#000000', '#cccccc']);
  });

  it('skips custom-property declarations (property starting with --)', () => {
    const facts = makeFacts([decl('#123456', 'other', '--brand-bg')]);

    expect(extractSitePalette(facts)).toEqual([]);
  });

  it('skips entries with a null color', () => {
    const facts = makeFacts([
      { selector: '.el', property: 'color', value: 'currentColor', color: null, bucket: 'other' },
    ]);

    expect(extractSitePalette(facts)).toEqual([]);
  });

  it('excludes translucent declarations from the palette; opaque siblings unaffected', () => {
    const facts = makeFacts([
      decl('#112233', 'background'),
      {
        selector: '.scrim',
        property: 'background-color',
        value: 'rgba(17, 34, 51, 0.5)',
        color: parseCssColor('rgba(17, 34, 51, 0.5)'),
        bucket: 'background',
      },
    ]);

    const palette = extractSitePalette(facts);

    expect(palette).toHaveLength(1);
    expect(palette[0]).toMatchObject({ hex: '#112233', weight: 1 });
  });
});

describe('buildColorMapping — background ladder', () => {
  const ladderPalette = [
    entry('#101010', 'background'),
    entry('#404040', 'background'),
    entry('#808080', 'background'),
    entry('#c0c0c0', 'background'),
    entry('#f0f0f0', 'background'),
  ];

  it('walks canvas, surface1, surface2, surface3, surface3... ascending by l in dark mode', () => {
    const mapping = buildColorMapping(ladderPalette, catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get('#101010')).toBe(catppuccinFrappe.tokens.canvas);
    expect(mapping.get('#404040')).toBe(catppuccinFrappe.tokens.surface1);
    expect(mapping.get('#808080')).toBe(catppuccinFrappe.tokens.surface2);
    expect(mapping.get('#c0c0c0')).toBe(catppuccinFrappe.tokens.surface3);
    expect(mapping.get('#f0f0f0')).toBe(catppuccinFrappe.tokens.surface3);
  });

  it('walks the ladder descending by l in light mode', () => {
    const lightTheme: PaletteTheme = { ...catppuccinFrappe, mode: 'light' };

    const mapping = buildColorMapping(
      [entry('#101010', 'background'), entry('#f0f0f0', 'background')],
      lightTheme,
      { preserveBrandColors: false },
    );

    expect(mapping.get('#f0f0f0')).toBe(lightTheme.tokens.canvas);
    expect(mapping.get('#101010')).toBe(lightTheme.tokens.surface1);
  });

  it('breaks equal-l ties by ascending hex', () => {
    // Same underlying color (so l ties exactly) under two different site
    // hexes, given in descending hex order to prove the tie-break — not
    // input order — decides the ladder position.
    const sharedColor = requireColor('#505050');
    const palette: SitePaletteEntry[] = [
      { hex: '#bbbbbb', color: sharedColor, weight: 1, bucket: 'background' },
      { hex: '#aaaaaa', color: sharedColor, weight: 1, bucket: 'background' },
    ];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false });

    expect(mapping.get('#aaaaaa')).toBe(catppuccinFrappe.tokens.canvas);
    expect(mapping.get('#bbbbbb')).toBe(catppuccinFrappe.tokens.surface1);
  });
});

describe('buildColorMapping — text bucket', () => {
  it('maps the heaviest text entry to text, the rest to textMuted', () => {
    const mapping = buildColorMapping(
      [entry('#eeeeee', 'text', 5), entry('#cccccc', 'text', 40)],
      catppuccinFrappe,
      { preserveBrandColors: false },
    );

    expect(mapping.get('#cccccc')).toBe(catppuccinFrappe.tokens.text);
    expect(mapping.get('#eeeeee')).toBe(catppuccinFrappe.tokens.textMuted);
  });
});

describe('buildColorMapping — border bucket', () => {
  it('maps every border entry to border', () => {
    const mapping = buildColorMapping(
      [entry('#333333', 'border'), entry('#444444', 'border')],
      catppuccinFrappe,
      { preserveBrandColors: false },
    );

    expect(mapping.get('#333333')).toBe(catppuccinFrappe.tokens.border);
    expect(mapping.get('#444444')).toBe(catppuccinFrappe.tokens.border);
  });
});

describe('buildColorMapping — accents', () => {
  it('maps a high-chroma entry to the hue-nearest of accent/link/success/warning/danger', () => {
    // Reuses the theme's own success color: hue distance to success is 0,
    // and clearly nonzero to every other accent token for this theme.
    const successHex = catppuccinFrappe.tokens.success;
    expect(oklchOf(successHex).c).toBeGreaterThan(0.09);

    const mapping = buildColorMapping([entry(successHex, 'other', 12)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get(successHex)).toBe(catppuccinFrappe.tokens.success);
  });

  it('breaks hue-distance ties using the fixed accent, link, success, warning, danger order', () => {
    // catppuccinFrappe.accent and .link are the identical hex, so an entry at
    // that exact hue ties both at distance 0; accent must win.
    expect(catppuccinFrappe.tokens.accent).toBe(catppuccinFrappe.tokens.link);
    const accentHex = catppuccinFrappe.tokens.accent;
    expect(oklchOf(accentHex).c).toBeGreaterThan(0.09);

    const mapping = buildColorMapping([entry(accentHex, 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get(accentHex)).toBe(catppuccinFrappe.tokens.accent);
  });

  it('still maps accents in the 0.09 < c <= 0.14 band when preserveBrandColors is true', () => {
    const midChromaHex = toHex(oklchToRgba({ l: 0.55, c: 0.11, h: 260 }));
    const midChroma = oklchOf(midChromaHex).c;
    expect(midChroma).toBeGreaterThan(0.09);
    expect(midChroma).toBeLessThanOrEqual(0.14);

    const mapping = buildColorMapping([entry(midChromaHex, 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: true,
    });

    expect(mapping.has(midChromaHex)).toBe(true);
  });

  it('excludes accents above the brand-preserve threshold (c > 0.14) when preserveBrandColors is true', () => {
    const highChromaHex = toHex(oklchToRgba({ l: 0.55, c: 0.24, h: 260 }));
    const highChroma = oklchOf(highChromaHex).c;
    expect(highChroma).toBeGreaterThan(0.14);

    const preserved = buildColorMapping([entry(highChromaHex, 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: true,
    });
    const notPreserved = buildColorMapping([entry(highChromaHex, 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(preserved.has(highChromaHex)).toBe(false);
    expect(notPreserved.has(highChromaHex)).toBe(true);
  });
});

describe('buildColorMapping — high-chroma text-bucket entries (finding 7)', () => {
  it('accent-partitions a high-chroma text-bucket entry instead of routing it through the text-bucket ladder', () => {
    const successHex = catppuccinFrappe.tokens.success;
    expect(oklchOf(successHex).c).toBeGreaterThan(0.09);

    const mapping = buildColorMapping([entry(successHex, 'text', 12)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get(successHex)).toBe(catppuccinFrappe.tokens.success);
    expect(mapping.get(successHex)).not.toBe(catppuccinFrappe.tokens.text);
    expect(mapping.get(successHex)).not.toBe(catppuccinFrappe.tokens.textMuted);
  });

  it('excludes a high-chroma (>0.14) text-bucket entry from the map when preserveBrandColors is set — guardContrast, not colorMap, owns its legibility repair (finding 5)', () => {
    const brandTextHex = '#007b00'; // own chroma ~0.172, past the brand-preserve threshold

    const mapping = buildColorMapping([entry(brandTextHex, 'text', 1)], catppuccinFrappe, {
      preserveBrandColors: true,
    });

    expect(mapping.has(brandTextHex)).toBe(false);
  });
});

describe('buildColorMapping — other bucket', () => {
  it('maps other-bucket entries to the nearest already-assigned ladder token by l distance', () => {
    const canvasL = oklchOf(catppuccinFrappe.tokens.canvas).l;
    const nearCanvasHex = toHex(oklchToRgba({ l: canvasL, c: 0, h: 0 }));

    const palette = [
      entry('#101010', 'background'),
      entry('#404040', 'background'),
      entry(nearCanvasHex, 'other', 1),
    ];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false });

    expect(mapping.get(nearCanvasHex)).toBe(catppuccinFrappe.tokens.canvas);
  });

  it('falls back to surface1 when the ladder assigned nothing (no background entries)', () => {
    const mapping = buildColorMapping([entry('#909090', 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get('#909090')).toBe(catppuccinFrappe.tokens.surface1);
  });
});

describe('buildColorMapping — golden palette', () => {
  it('produces a stable full mapping for a fixed 10-color palette on catppuccinFrappe', () => {
    const palette = [
      entry('#101014', 'background', 50),
      entry('#1c1c22', 'background', 30),
      entry('#26262e', 'background', 10),
      entry('#f5f5f7', 'text', 40),
      entry('#c9c9d1', 'text', 5),
      entry('#3a3a44', 'border', 15),
      entry('#7a7a82', 'other', 6),
      entry('#4287f5', 'other', 20),
      entry('#27ae60', 'other', 9),
      entry('#c0392b', 'other', 3),
    ];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false });

    expect(JSON.stringify(Object.fromEntries(mapping), null, 2)).toMatchInlineSnapshot(`
      "{
        "#101014": "#303446",
        "#1c1c22": "#414559",
        "#26262e": "#51576d",
        "#f5f5f7": "#c6d0f5",
        "#c9c9d1": "#a5adce",
        "#3a3a44": "#626880",
        "#7a7a82": "#51576d",
        "#4287f5": "#8caaee",
        "#27ae60": "#a6d189",
        "#c0392b": "#e78284"
      }"
    `);
  });
});

describe('determinism', () => {
  it('extractSitePalette produces identical output for identical input', () => {
    const facts = makeFacts(
      [decl('#111111', 'background'), decl('#222222', 'text'), decl('#333333', 'border')],
      [decl('#111111', 'other')],
    );

    const first = JSON.stringify(
      extractSitePalette(makeFacts(facts.authoredRules, facts.inlineStyleColors)),
    );
    const second = JSON.stringify(
      extractSitePalette(makeFacts(facts.authoredRules, facts.inlineStyleColors)),
    );

    expect(first).toBe(second);
  });

  it('buildColorMapping produces identical Map iteration order for identical input', () => {
    const palette = [
      entry('#101014', 'background', 50),
      entry('#1c1c22', 'background', 30),
      entry('#f5f5f7', 'text', 40),
      entry('#3a3a44', 'border', 15),
      entry('#4287f5', 'other', 20),
    ];

    const first = JSON.stringify([
      ...buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false }),
    ]);
    const second = JSON.stringify([
      ...buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false }),
    ]);

    expect(first).toBe(second);
  });
});
