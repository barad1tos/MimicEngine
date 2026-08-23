// src/core/engine/colorMap.test.ts
import { describe, expect, it } from 'vitest';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import {
  buildColorMapping,
  extractSitePalette,
  mapAccent,
  mappingKeyOf,
  type SitePaletteEntry,
} from './colorMap';
import { elevationBackgroundHex } from './elevationScale';
import type { AuthoredColorDeclaration, PageFacts } from './pageFacts';

const catppuccinFrappe = builtInThemes[0];

type PaletteBucket = AuthoredColorDeclaration['bucket'];

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
}

// Converts a plain CSS color literal to the branded HexColor type ColorMapping
// and SitePaletteEntry now require — the same toHex(parseCssColor(...)) path
// production code uses, just wrapped for test-fixture literals.
function hex(value: string): HexColor {
  return toHex(requireColor(value));
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
  return { selector, property, value: hex, color: parseCssColor(hex), bucket, conditions: [] };
}

function makeFacts(
  authoredRules: AuthoredColorDeclaration[],
  inlineStyleColors: AuthoredColorDeclaration[] = [],
): PageFacts {
  return {
    customProperties: [],
    authoredRules,
    inlineStyleColors,
    svgPresentationColors: [],
    domElementCount: 0,
    shadowRootCount: 0,
    stylesheetCount: 0,
    unreadableStylesheetCount: 0,
  };
}

function entry(
  hex: string,
  bucket: PaletteBucket,
  weight = 1,
  elevation?: number,
): SitePaletteEntry {
  return {
    hex: toHex(requireColor(hex)),
    color: requireColor(hex),
    weight,
    bucket,
    ...(elevation === undefined ? {} : { elevation }),
  };
}

function mappingKey(value: string, bucket: PaletteBucket, elevation?: number): string {
  return mappingKeyOf(entry(value, bucket, 1, elevation));
}

describe('extractSitePalette', () => {
  it('keeps the same source hex separate when background and text use different roles', () => {
    const facts = makeFacts(
      [decl('#112233', 'background'), decl('#112233', 'background')],
      [decl('#112233', 'text')],
    );

    const palette = extractSitePalette(facts);

    expect(palette).toEqual([
      expect.objectContaining({ hex: '#112233', bucket: 'background', weight: 2 }),
      expect.objectContaining({ hex: '#112233', bucket: 'text', weight: 1 }),
    ]);
  });

  it('dedupes repeated uses within the same role', () => {
    const facts = makeFacts([decl('#a1a1a1', 'text'), decl('#a1a1a1', 'text')]);

    const palette = extractSitePalette(facts);

    expect(palette).toHaveLength(1);
    expect(palette[0]).toMatchObject({ hex: '#a1a1a1', bucket: 'text', weight: 2 });
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
      {
        selector: '.el',
        property: 'color',
        value: 'currentColor',
        color: null,
        bucket: 'other',
        conditions: [],
      },
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
        conditions: [],
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

  it('walks elevation-0, -1, -2, -3, -3... ascending by l in dark mode', () => {
    const mapping = buildColorMapping(ladderPalette, catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get(mappingKey('#101010', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 0),
    );
    expect(mapping.get(mappingKey('#404040', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 1),
    );
    expect(mapping.get(mappingKey('#808080', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 2),
    );
    expect(mapping.get(mappingKey('#c0c0c0', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 3),
    );
    expect(mapping.get(mappingKey('#f0f0f0', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 3),
    );
  });

  it('walks the ladder descending by l in light mode', () => {
    const lightTheme: PaletteTheme = { ...catppuccinFrappe, mode: 'light' };

    const mapping = buildColorMapping(
      [entry('#101010', 'background'), entry('#f0f0f0', 'background')],
      lightTheme,
      { preserveBrandColors: false },
    );

    expect(mapping.get(mappingKey('#f0f0f0', 'background'))).toBe(
      elevationBackgroundHex(lightTheme, 0),
    );
    expect(mapping.get(mappingKey('#101010', 'background'))).toBe(
      elevationBackgroundHex(lightTheme, 1),
    );
  });

  it('breaks equal-l ties by ascending hex', () => {
    // Same underlying color (so l ties exactly) under two different site
    // hexes, given in descending hex order to prove the tie-break — not
    // input order — decides the ladder position.
    const sharedColor = requireColor('#505050');
    const palette: SitePaletteEntry[] = [
      { hex: hex('#bbbbbb'), color: sharedColor, weight: 1, bucket: 'background' },
      { hex: hex('#aaaaaa'), color: sharedColor, weight: 1, bucket: 'background' },
    ];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false });

    expect(mapping.get(mappingKey('#aaaaaa', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 0),
    );
    expect(mapping.get(mappingKey('#bbbbbb', 'background'))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 1),
    );
  });
});

describe('buildColorMapping — elevation-aware background ladder', () => {
  it('same hex at different elevations lands on different ladder rungs', () => {
    const palette = [entry('#ffffff', 'background', 10, 0), entry('#ffffff', 'background', 5, 1)];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: true });

    expect(mapping.get(mappingKey('#ffffff', 'background', 0))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 0),
    );
    expect(mapping.get(mappingKey('#ffffff', 'background', 1))).toBe(
      elevationBackgroundHex(catppuccinFrappe, 1),
    );
  });

  it('elevation IS the level directly: entries sharing an elevation collapse onto the same rung regardless of luminance or raw hex', () => {
    // Amendment 3: a census entry's elevation is already an engine-owned
    // stacking LEVEL, not a relative position among this page's sampled
    // colors -- so two entries at elevation 0 (one darker, one lighter) must
    // land on the exact SAME rung as each other, not two different ones the
    // way a pure luminance-ordered walk would place them.
    const palette = [
      entry('#f4f2ee', 'background', 10, 0), // darker, ground
      entry('#ffffff', 'background', 8, 0), // lighter, same ground level
      entry('#ffffff', 'background', 5, 1), // raised: distinct level
    ];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: true });

    const groundKey = mappingKey('#ffffff', 'background', 0);
    const darkerGroundKey = mappingKey('#f4f2ee', 'background', 0);
    const raisedKey = mappingKey('#ffffff', 'background', 1);
    expect(mapping.get(darkerGroundKey)).toBe(elevationBackgroundHex(catppuccinFrappe, 0));
    expect(mapping.get(groundKey)).toBe(elevationBackgroundHex(catppuccinFrappe, 0));
    expect(mapping.get(darkerGroundKey)).toBe(mapping.get(groundKey));
    expect(mapping.get(raisedKey)).toBe(elevationBackgroundHex(catppuccinFrappe, 1));
    expect(mapping.get(raisedKey)).not.toBe(mapping.get(groundKey));
  });

  it('entries without elevation keep role-aware keys end to end', () => {
    const palette = [entry('#101010', 'background', 3)];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: true });

    expect(mapping.has(mappingKey('#101010', 'background'))).toBe(true);
  });

  it('keeps an elevated accent background under its full mapping identity', () => {
    // Confirms this fixture actually exercises the accent-partition path
    // (chroma above ACCENT_CHROMA_THRESHOLD), not the background ladder.
    expect(oklchOf('#dd2222').c).toBeGreaterThan(0.09);

    const accentEntry = entry('#dd2222', 'background', 1, 1);
    const palette = [accentEntry];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: false });

    expect(mapping.size).toBe(1);
    expect(mapping.get(mappingKey('#dd2222', 'background', 1))).toBe(
      mapAccent(accentEntry, catppuccinFrappe, false),
    );
  });
});

describe('buildColorMapping — text bucket', () => {
  it('maps the heaviest text entry to text, the rest to textMuted', () => {
    const mapping = buildColorMapping(
      [entry('#eeeeee', 'text', 5), entry('#cccccc', 'text', 40)],
      catppuccinFrappe,
      { preserveBrandColors: false },
    );

    expect(mapping.get(mappingKey('#cccccc', 'text'))).toBe(catppuccinFrappe.tokens.text);
    expect(mapping.get(mappingKey('#eeeeee', 'text'))).toBe(catppuccinFrappe.tokens.textMuted);
  });
});

describe('buildColorMapping — border bucket', () => {
  it('maps every border entry to border', () => {
    const mapping = buildColorMapping(
      [entry('#333333', 'border'), entry('#444444', 'border')],
      catppuccinFrappe,
      { preserveBrandColors: false },
    );

    expect(mapping.get(mappingKey('#333333', 'border'))).toBe(catppuccinFrappe.tokens.border);
    expect(mapping.get(mappingKey('#444444', 'border'))).toBe(catppuccinFrappe.tokens.border);
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

    expect(mapping.get(mappingKey(successHex, 'other'))).toBe(catppuccinFrappe.tokens.success);
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

    expect(mapping.get(mappingKey(accentHex, 'other'))).toBe(catppuccinFrappe.tokens.accent);
  });

  it('still maps accents in the 0.09 < c <= 0.14 band when preserveBrandColors is true', () => {
    const midChromaHex = toHex(oklchToRgba({ l: 0.55, c: 0.11, h: 260 }));
    const midChroma = oklchOf(midChromaHex).c;
    expect(midChroma).toBeGreaterThan(0.09);
    expect(midChroma).toBeLessThanOrEqual(0.14);

    const mapping = buildColorMapping([entry(midChromaHex, 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: true,
    });

    expect(mapping.has(mappingKey(midChromaHex, 'other'))).toBe(true);
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

    expect(preserved.has(mappingKey(highChromaHex, 'other'))).toBe(false);
    expect(notPreserved.has(mappingKey(highChromaHex, 'other'))).toBe(true);
  });
});

describe('buildColorMapping — high-chroma text-bucket entries (finding 7)', () => {
  it('accent-partitions a high-chroma text-bucket entry instead of routing it through the text-bucket ladder', () => {
    const successHex = catppuccinFrappe.tokens.success;
    expect(oklchOf(successHex).c).toBeGreaterThan(0.09);

    const mapping = buildColorMapping([entry(successHex, 'text', 12)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    const successKey = mappingKey(successHex, 'text');
    expect(mapping.get(successKey)).toBe(catppuccinFrappe.tokens.success);
    expect(mapping.get(successKey)).not.toBe(catppuccinFrappe.tokens.text);
    expect(mapping.get(successKey)).not.toBe(catppuccinFrappe.tokens.textMuted);
  });

  it('excludes a high-chroma (>0.14) text-bucket entry from the map when preserveBrandColors is set — guardContrast, not colorMap, owns its legibility repair (finding 5)', () => {
    const brandTextHex = '#007b00'; // own chroma ~0.172, past the brand-preserve threshold

    const mapping = buildColorMapping([entry(brandTextHex, 'text', 1)], catppuccinFrappe, {
      preserveBrandColors: true,
    });

    expect(mapping.has(mappingKey(brandTextHex, 'text'))).toBe(false);
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

    expect(mapping.get(mappingKey(nearCanvasHex, 'other'))).toBe(catppuccinFrappe.tokens.canvas);
  });

  it('falls back to surface1 when the ladder assigned nothing (no background entries)', () => {
    const mapping = buildColorMapping([entry('#909090', 'other', 1)], catppuccinFrappe, {
      preserveBrandColors: false,
    });

    expect(mapping.get(mappingKey('#909090', 'other'))).toBe(catppuccinFrappe.tokens.surface1);
  });
});

describe('buildColorMapping — golden palette', () => {
  // Background roles map to the theme's authored semantic surface ladder,
  // keeping color mapping aligned with emitted elevation variables.
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
        "#101014|background": "#303446",
        "#1c1c22|background": "#414559",
        "#26262e|background": "#51576d",
        "#f5f5f7|text": "#c6d0f5",
        "#c9c9d1|text": "#a5adce",
        "#3a3a44|border": "#626880",
        "#7a7a82|other": "#51576d",
        "#4287f5|other": "#8caaee",
        "#27ae60|other": "#a6d189",
        "#c0392b|other": "#e78284"
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
