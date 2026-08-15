import { describe, expect, it } from 'vitest';
import { compareStrings } from './sort';

describe('compareStrings', () => {
  it('disagrees with localeCompare on a pair ICU collation reorders by case', () => {
    // en-US (and most Latin-alphabet) ICU collation ranks letters before
    // case, so 'a' sorts before 'B'. Raw codepoints go the other way:
    // 'a' is 0x61, 'B' is 0x42, so 'a' > 'B'. This pins the codepoint
    // semantics compareStrings must have, regardless of runtime locale.
    expect('a'.localeCompare('B')).toBeLessThan(0);
    expect(compareStrings('a', 'B')).toBeGreaterThan(0);
  });

  it('returns 0 for equal strings and orders unequal ones by codepoint', () => {
    expect(compareStrings('abc', 'abc')).toBe(0);
    expect(compareStrings('abc', 'abd')).toBeLessThan(0);
    expect(compareStrings('abd', 'abc')).toBeGreaterThan(0);
  });
});
