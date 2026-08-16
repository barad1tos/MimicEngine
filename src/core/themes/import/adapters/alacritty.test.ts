import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseAlacrittyTheme } from './alacritty';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/ayu-mirage.alacritty.toml', import.meta.url),
);
const AYU_MIRAGE_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseAlacrittyTheme', () => {
  it('maps the real ayu-mirage fixture: hand-verified hexes, full ansi palette, no selection section', () => {
    const slots = expectSlots(parseAlacrittyTheme(AYU_MIRAGE_FIXTURE));

    expect(slots.sourceFormat).toBe('alacritty');
    // The canonical alacritty-theme fixture carries no name field of its own
    // (confirmed by reading it: comments plus [colors.*] sections only) --
    // same kind of format default the other terminal-style adapters use.
    expect(slots.name).toBe('Alacritty theme');

    // Hand-verified against [colors.primary]:
    expect(slots.background).toBe('#1f2430');
    expect(slots.foreground).toBe('#cbccc6');
    // The fixture has no [colors.selection] section at all -- stays unset.
    expect(slots.tokens.selection).toBeUndefined();

    // [colors.normal] -> ansi[0..7], hand-verified in file order:
    expect(slots.ansi?.[0]).toBe('#212733');
    expect(slots.ansi?.[1]).toBe('#f08778');
    expect(slots.ansi?.[2]).toBe('#53bf97');
    expect(slots.ansi?.[3]).toBe('#fdcc60');
    expect(slots.ansi?.[4]).toBe('#60b8d6');
    expect(slots.ansi?.[5]).toBe('#ec7171');
    expect(slots.ansi?.[6]).toBe('#98e6ca');
    expect(slots.ansi?.[7]).toBe('#fafafa');

    // [colors.bright] -> ansi[8..15], hand-verified in file order:
    expect(slots.ansi?.[8]).toBe('#686868');
    expect(slots.ansi?.[9]).toBe('#f58c7d');
    expect(slots.ansi?.[10]).toBe('#58c49c');
    expect(slots.ansi?.[11]).toBe('#ffd165');
    expect(slots.ansi?.[12]).toBe('#65bddb');
    expect(slots.ansi?.[13]).toBe('#f17676');
    expect(slots.ansi?.[14]).toBe('#9debcf');
    expect(slots.ansi?.[15]).toBe('#ffffff');
  });

  it('skips an unknown key under [colors.primary] (bright_foreground) without leaking it anywhere', () => {
    // The real fixture's `bright_foreground` under [colors.primary] must not
    // land in background/foreground/ansi -- Alacritty itself doesn't map it
    // to a theme slot, so this adapter drops it silently.
    const slots = expectSlots(parseAlacrittyTheme(AYU_MIRAGE_FIXTURE));
    expect(slots.background).not.toBe('#f28779');
    expect(slots.foreground).not.toBe('#f28779');
    expect(slots.ansi).not.toContain('#f28779');
  });

  it('accepts 0x-prefixed hex literals alongside quoted #rrggbb ones', () => {
    const content = `
[colors.primary]
background = "0x101010"
foreground = '0xF0F0F0'
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.background).toBe('#101010');
    expect(slots.foreground).toBe('#f0f0f0');
  });

  it('maps [colors.selection] background to tokens.selection', () => {
    const content = `
[colors.primary]
background = "#101010"
foreground = "#f0f0f0"

[colors.selection]
background = "#334455"
text = "#f0f0f0"
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.tokens.selection).toBe('#334455');
  });

  it('skips a malformed (non-hex) value under a recognized key, leaving that slot unset', () => {
    const content = `
[colors.primary]
background = "not-a-color"
foreground = "#f0f0f0"
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.background).toBeUndefined();
    expect(slots.foreground).toBe('#f0f0f0');
  });

  it('skips a stray line with no "=" and a line with an empty key, inside a known section', () => {
    const content = `
[colors.primary]
not_a_key_value_line
= somevalue
foreground = "#f0f0f0"
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.foreground).toBe('#f0f0f0');
    expect(slots.background).toBeUndefined();
  });

  it('skips an unrecognized key under [colors.normal] without disturbing recognized ones', () => {
    const content = `
[colors.normal]
black = "#212733"
foo = "#123456"
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.ansi?.[0]).toBe('#212733');
    expect(slots.ansi).not.toContain('#123456');
  });

  it('succeeds with only background set (no foreground, no selection, no ansi)', () => {
    const content = `
[colors.primary]
background = "#101010"
`;
    const slots = expectSlots(parseAlacrittyTheme(content));
    expect(slots.background).toBe('#101010');
    expect(slots.foreground).toBeUndefined();
  });

  it('ignores keys under an unrecognized section header', () => {
    const content = `
[colors.cursor]
style = "Block"
`;
    const error = expectError(parseAlacrittyTheme(content));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when the file yields no color entries at all', () => {
    const content = `
# just comments, no color sections
[general]
live_config_reload = true
`;
    const error = expectError(parseAlacrittyTheme(content));
    expect(error.stage).toBe('parse');
    expect(error.message).toBe('no color entries found');
  });
});
