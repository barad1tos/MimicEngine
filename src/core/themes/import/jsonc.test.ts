import { describe, expect, it } from 'vitest';
import { stripJsonc } from './jsonc';

describe('stripJsonc', () => {
  it('strips line comments', () => {
    const input = `{
  "a": 1, // comment
  "b": 2
}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: 1, b: 2 });
  });

  it('strips block comments, including multi-line ones', () => {
    const input = `{
  /* leading
     comment */
  "a": 1,
  "b": /* inline */ 2
}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: 1, b: 2 });
  });

  it('removes trailing commas before closing braces and brackets', () => {
    const input = `{
  "a": [1, 2, 3,],
  "b": 2,
}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: [1, 2, 3], b: 2 });
  });

  it('leaves // inside a string value untouched', () => {
    const input = `{"url": "https://example.com//path"}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ url: 'https://example.com//path' });
  });

  it('leaves /* and */ inside a string value untouched', () => {
    const input = `{"note": "a /* not a comment */ still text"}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ note: 'a /* not a comment */ still text' });
  });

  it('leaves a trailing-comma-shaped comma inside a string value untouched', () => {
    const input = `{"note": "trailing, }"}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ note: 'trailing, }' });
  });

  it('preserves an escaped quote inside a string value while still stripping comments and trailing commas', () => {
    const input = `{
  "a": "quote: \\" here", // comment
  "b": 1,
}`;
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: 'quote: " here', b: 1 });
  });

  it('is a no-op on content with no comments or trailing commas', () => {
    const input = `{"a":1,"b":2}`;
    expect(stripJsonc(input)).toBe(input);
  });
});
