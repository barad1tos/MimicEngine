import { describe, expect, it } from 'vitest';
import { compositeOverOpaque, contrastRatio, passesContrast } from './contrast';
import { parseCssColor, toHex } from './parseColor';

describe('parseCssColor', () => {
  it('parses hex colors', () => {
    expect(parseCssColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('parses rgb colors', () => {
    expect(parseCssColor('rgb(12, 34, 56)')).toEqual({ r: 12, g: 34, b: 56, a: 1 });
  });

  it('serializes to hex', () => {
    expect(toHex({ r: 12, g: 34, b: 56, a: 1 })).toBe('#0c2238');
  });
});

describe('contrastRatio', () => {
  it('calculates high contrast for black and white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('checks contrast threshold', () => {
    expect(passesContrast('#000000', '#ffffff')).toBe(true);
    expect(passesContrast('#777777', '#888888')).toBe(false);
  });

  it('composites translucent foreground over the background', () => {
    const nearlyWhiteOnWhite = contrastRatio('rgba(0, 0, 0, 0.1)', '#ffffff');
    expect(nearlyWhiteOnWhite).not.toBeNull();
    expect(nearlyWhiteOnWhite).toBeLessThan(1.5);
    expect(passesContrast('rgba(0, 0, 0, 0.1)', '#ffffff')).toBe(false);
  });

  it('returns null for a translucent background with an unknown backdrop', () => {
    expect(contrastRatio('#000000', 'rgba(255, 255, 255, 0.5)')).toBeNull();
    expect(contrastRatio('#000000', 'rgba(255, 255, 255, 0)')).toBeNull();
  });
});

describe('compositeOverOpaque', () => {
  it('resolves a translucent foreground against an opaque backdrop', () => {
    expect(
      toHex(compositeOverOpaque({ r: 0, g: 0, b: 0, a: 0.9 }, { r: 36, g: 41, b: 54, a: 1 })),
    ).toBe('#040405');
  });
});
