import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseKittyTheme } from './kitty';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/ayu-mirage.kitty.conf', import.meta.url));
const AYU_MIRAGE_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseKittyTheme', () => {
  it("maps the owner's real ayu-mirage kitty.conf: hand-verified hexes, full ansi palette, no url_color", () => {
    const slots = expectSlots(parseKittyTheme(AYU_MIRAGE_FIXTURE));

    expect(slots.sourceFormat).toBe('kitty');
    // kitty.conf carries no name field of its own -- same kind of format
    // default the other terminal-style adapters use.
    expect(slots.name).toBe('kitty theme');

    // Hand-verified against the fixture's top-of-file inline palette block.
    expect(slots.background).toBe('#1f2430');
    expect(slots.foreground).toBe('#cbccc6');
    expect(slots.tokens.selection).toBe('#34455a');
    // The fixture never sets url_color -- stays unset.
    expect(slots.tokens.link).toBeUndefined();

    // color0..color15, hand-verified in file order (grouped by name, low
    // index first then its "bright" +8 counterpart):
    expect(slots.ansi?.[0]).toBe('#191e2a');
    expect(slots.ansi?.[8]).toBe('#686868');
    expect(slots.ansi?.[1]).toBe('#ed8274');
    expect(slots.ansi?.[9]).toBe('#f28779');
    expect(slots.ansi?.[2]).toBe('#a6cc70');
    expect(slots.ansi?.[10]).toBe('#bae67e');
    expect(slots.ansi?.[3]).toBe('#fad07b');
    expect(slots.ansi?.[11]).toBe('#ffd580');
    expect(slots.ansi?.[4]).toBe('#6dcbfa');
    expect(slots.ansi?.[12]).toBe('#73d0ff');
    expect(slots.ansi?.[5]).toBe('#cfbafa');
    expect(slots.ansi?.[13]).toBe('#d4bfff');
    expect(slots.ansi?.[6]).toBe('#90e1c6');
    expect(slots.ansi?.[14]).toBe('#95e6cb');
    expect(slots.ansi?.[7]).toBe('#c7c7c7');
    expect(slots.ansi?.[15]).toBe('#ffffff');
  });

  it('skips non-color settings entirely, including multi-value lines like window_padding_width', () => {
    // The fixture carries font, window, tab-bar, and keybinding settings
    // alongside the palette -- none of it should surface as an error or
    // corrupt a color slot. A clean parse of the whole file is the proof.
    const slots = expectSlots(parseKittyTheme(AYU_MIRAGE_FIXTURE));
    expect(slots.background).not.toBeUndefined();
    expect(slots.ansi).toHaveLength(16);
  });

  it('maps url_color to tokens.link', () => {
    const content = `
background #101010
foreground #f0f0f0
url_color #6699cc
`;
    const slots = expectSlots(parseKittyTheme(content));
    expect(slots.tokens.link).toBe('#6699cc');
  });

  it('accepts a bare (unprefixed) hex value for a color key', () => {
    const content = `
background 101010
color0 191e2a
`;
    const slots = expectSlots(parseKittyTheme(content));
    expect(slots.background).toBe('#101010');
    expect(slots.ansi?.[0]).toBe('#191e2a');
  });

  it('ignores an out-of-range colorN key (color16)', () => {
    const content = `
background #101010
color16 #ffffff
`;
    const slots = expectSlots(parseKittyTheme(content));
    expect(slots.ansi).toBeUndefined();
  });

  it('skips malformed (non-hex) values under every recognized key, leaving those slots unset', () => {
    const content = `
background notahex
foreground notahex
selection_background notahex
url_color notahex
color0 #191e2a
color1 notahex
`;
    const slots = expectSlots(parseKittyTheme(content));
    expect(slots.background).toBeUndefined();
    expect(slots.foreground).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
    expect(slots.tokens.link).toBeUndefined();
    expect(slots.ansi?.[0]).toBe('#191e2a');
    expect(slots.ansi?.[1]).toBeUndefined();
  });

  it('skips a key-only line with no value after it', () => {
    const content = `
disable_ligatures
background #101010
`;
    const slots = expectSlots(parseKittyTheme(content));
    expect(slots.background).toBe('#101010');
  });

  it('returns a parse error when the file yields no color entries at all', () => {
    const content = `
# a kitty.conf with no color settings
font_family MesloLGS Nerd Font
window_padding_width 10 15 10 15
`;
    const error = expectError(parseKittyTheme(content));
    expect(error.stage).toBe('parse');
    expect(error.message).toBe('no color entries found');
  });
});
