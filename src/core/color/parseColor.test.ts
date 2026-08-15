import { describe, expect, it } from 'vitest';
import { parseCssColor } from './parseColor';

describe('parseCssColor hsl', () => {
  it('parses comma syntax', () => {
    expect(parseCssColor('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('hsl(120, 100%, 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
  });

  it('parses hsla and slash alpha', () => {
    expect(parseCssColor('hsla(0, 100%, 50%, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('hsl(0 100% 50% / 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
  });

  it('returns null for raw triplets and junk', () => {
    expect(parseCssColor('222.2 84% 4.9%')).toBeNull();
    expect(parseCssColor('hsl(nonsense)')).toBeNull();
  });
});
