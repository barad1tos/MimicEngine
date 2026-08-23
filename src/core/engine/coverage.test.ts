import { describe, expect, it } from 'vitest';
import { toHex, type HexColor } from '../color/parseColor';
import { mappingKeyOf, type ColorMapping, type SitePaletteEntry } from './colorMap';
import { aggregateCoverage, computeCoverage, coverageFromCounts } from './coverage';

function hex(r: number, g: number, b: number): HexColor {
  return toHex({ r, g, b, a: 1 });
}

function mappingKey(r: number, g: number, b: number, bucket: SitePaletteEntry['bucket']): string {
  return mappingKeyOf({ hex: hex(r, g, b), bucket });
}

describe('computeCoverage', () => {
  it('returns {0, 0, 0} for an empty palette', () => {
    const palette: SitePaletteEntry[] = [];
    const mapping: ColorMapping = new Map();

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 0, mapped: 0, ratio: 0 });
  });

  it('computes ratio correctly for partial mapping', () => {
    const palette: SitePaletteEntry[] = [
      { hex: hex(255, 0, 0), color: { r: 255, g: 0, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: hex(0, 255, 0), color: { r: 0, g: 255, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: hex(0, 0, 255), color: { r: 0, g: 0, b: 255, a: 1 }, weight: 1, bucket: 'text' },
    ];
    const mapping: ColorMapping = new Map([
      [mappingKey(255, 0, 0, 'text'), hex(255, 255, 255)],
      [mappingKey(0, 255, 0, 'text'), hex(0, 0, 0)],
    ]);

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 3, mapped: 2, ratio: 2 / 3 });
  });

  it('returns ratio 1 for fully mapped palette', () => {
    const palette: SitePaletteEntry[] = [
      { hex: hex(255, 0, 0), color: { r: 255, g: 0, b: 0, a: 1 }, weight: 1, bucket: 'text' },
      { hex: hex(0, 255, 0), color: { r: 0, g: 255, b: 0, a: 1 }, weight: 1, bucket: 'text' },
    ];
    const mapping: ColorMapping = new Map([
      [mappingKey(255, 0, 0, 'text'), hex(255, 255, 255)],
      [mappingKey(0, 255, 0, 'text'), hex(0, 0, 0)],
    ]);

    const result = computeCoverage(palette, mapping);

    expect(result).toEqual({ discovered: 2, mapped: 2, ratio: 1 });
  });

  it('counts one raw color once when multiple roles map it independently', () => {
    const background: SitePaletteEntry = {
      hex: hex(119, 119, 119),
      color: { r: 119, g: 119, b: 119, a: 1 },
      weight: 1,
      bucket: 'background',
    };
    const text: SitePaletteEntry = { ...background, bucket: 'text' };
    const mapping: ColorMapping = new Map([
      [mappingKeyOf(background), hex(30, 30, 30)],
      [mappingKeyOf(text), hex(240, 240, 240)],
    ]);

    expect(computeCoverage([background, text], mapping)).toEqual({
      discovered: 1,
      mapped: 1,
      ratio: 1,
    });
  });
});

describe('aggregateCoverage', () => {
  it('returns undefined for an empty list of reports', () => {
    expect(aggregateCoverage([])).toBeUndefined();
  });

  it('sums discovered/mapped across reports and recomputes ratio from the sums', () => {
    const result = aggregateCoverage([
      { discovered: 10, mapped: 8, ratio: 0.8 },
      { discovered: 5, mapped: 1, ratio: 0.2 },
    ]);

    expect(result).toEqual({ discovered: 15, mapped: 9, ratio: 0.6 });
  });

  it('applies the discovered===0 -> 0 rule when every report discovered nothing', () => {
    const result = aggregateCoverage([{ discovered: 0, mapped: 0, ratio: 0 }]);

    expect(result).toEqual({ discovered: 0, mapped: 0, ratio: 0 });
  });
});

describe('coverageFromCounts', () => {
  it('returns {0, 0, 0} when nothing was discovered', () => {
    expect(coverageFromCounts(0, 0)).toEqual({ discovered: 0, mapped: 0, ratio: 0 });
  });

  it('computes ratio from raw discovered/mapped counts', () => {
    expect(coverageFromCounts(4, 3)).toEqual({ discovered: 4, mapped: 3, ratio: 0.75 });
  });
});
