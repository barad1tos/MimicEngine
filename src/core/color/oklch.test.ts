import { describe, expect, it } from 'vitest';
import { hueDistance, oklchToRgba, rgbaToOklch } from './oklch';

describe('rgbaToOklch', () => {
  it('maps pure white to l≈1, c≈0', () => {
    const result = rgbaToOklch({ r: 255, g: 255, b: 255, a: 1 });
    expect(result.l).toBeCloseTo(1, 2);
    expect(result.c).toBeCloseTo(0, 2);
  });

  it('maps pure black to l≈0', () => {
    const result = rgbaToOklch({ r: 0, g: 0, b: 0, a: 1 });
    expect(result.l).toBeCloseTo(0, 2);
    expect(result.c).toBeCloseTo(0, 2);
    expect(result.h).toBe(0);
  });

  it('matches the known OKLCH values for pure red', () => {
    const result = rgbaToOklch({ r: 255, g: 0, b: 0, a: 1 });
    expect(result.l).toBeCloseTo(0.628, 2);
    expect(result.c).toBeCloseTo(0.258, 2);
    expect(result.h).toBeCloseTo(29.2, 1);
  });
});

describe('round-trip rgbaToOklch <-> oklchToRgba', () => {
  const samples = [
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 255, b: 0, a: 1 },
    { r: 0, g: 0, b: 255, a: 1 },
    { r: 0x30, g: 0x34, b: 0x46, a: 1 },
    { r: 0xf5, g: 0xf1, b: 0xe8, a: 1 },
    { r: 0xb3, g: 0x54, b: 0x1e, a: 1 },
    { r: 0x80, g: 0x80, b: 0x80, a: 1 },
    { r: 0x12, g: 0x34, b: 0x56, a: 1 },
  ];

  it.each(samples)('round-trips %o within ±1 channel', (color) => {
    const roundTripped = oklchToRgba(rgbaToOklch(color));
    expect(Math.abs(roundTripped.r - color.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundTripped.g - color.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundTripped.b - color.b)).toBeLessThanOrEqual(1);
    expect(roundTripped.a).toBe(1);
  });
});

describe('oklchToRgba', () => {
  it('gamut-clamps channels to 0..255 and rounds', () => {
    const result = oklchToRgba({ l: 1, c: 0, h: 0 });
    expect(result).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('clamps a genuinely out-of-gamut color to 0..255 (negative pre-clamp channels)', () => {
    // l=0.5, c=0.37, h=150 is far beyond the sRGB gamut boundary for this
    // hue: the pre-clamp linear-RGB conversion lands red and blue well below
    // 0, not merely rounds to 0 by coincidence.
    const result = oklchToRgba({ l: 0.5, c: 0.37, h: 150 });
    expect(result).toEqual({ r: 0, g: 143, b: 0, a: 1 });
  });
});

describe('hueDistance', () => {
  it('wraps around 0/360 correctly', () => {
    expect(hueDistance(350, 10)).toBe(20);
  });

  it('is symmetric', () => {
    expect(hueDistance(350, 10)).toBe(hueDistance(10, 350));
    expect(hueDistance(15, 200)).toBe(hueDistance(200, 15));
  });

  it('returns 0 for identical hues and 180 for opposite hues', () => {
    expect(hueDistance(90, 90)).toBe(0);
    expect(hueDistance(0, 180)).toBe(180);
  });
});
