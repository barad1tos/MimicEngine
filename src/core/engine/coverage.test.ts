import { describe, expect, it } from 'vitest';
import type { ColorMapping, SitePaletteEntry } from './colorMap';
import { computeCoverage } from './coverage';

describe('computeCoverage', () => {
  it('returns {0, 0, 0} for an empty palette', () => {
    const palette: SitePaletteEntry[] = [];
    const mapping: ColorMapping = new Map();

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 0, mapped: 0, ratio: 0 });
  });

  it('computes ratio correctly for partial mapping', () => {
    const palette: SitePaletteEntry[] = [
      { hex: '#ff0000', color: { r: 255, g: 0, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: '#00ff00', color: { r: 0, g: 255, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: '#0000ff', color: { r: 0, g: 0, b: 255, a: 1 }, weight: 1, bucket: 'text' },
    ];
    const mapping: ColorMapping = new Map([
      ['#ff0000', '#ffffff'],
      ['#00ff00', '#000000'],
    ]);

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 3, mapped: 2, ratio: 2 / 3 });
  });

  it('returns ratio 1 for fully mapped palette', () => {
    const palette: SitePaletteEntry[] = [
      { hex: '#ff0000', color: { r: 255, g: 0, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: '#00ff00', color: { r: 0, g: 255, b: 0, a: 1 }, weight: 1, bucket: 'text' },
    ];
    const mapping: ColorMapping = new Map([
      ['#ff0000', '#ffffff'],
      ['#00ff00', '#000000'],
    ]);

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 2, mapped: 2, ratio: 1 });
  });
});
