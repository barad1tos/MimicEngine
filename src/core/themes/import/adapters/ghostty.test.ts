import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseGhosttyTheme } from './ghostty';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/catppuccin-macchiato.ghostty.conf', import.meta.url),
);
const CATPPUCCIN_MACCHIATO_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseGhosttyTheme', () => {
  it('maps the real Catppuccin Macchiato ghostty theme: bare-hex primaries, #-prefixed palette, full ansi', () => {
    const slots = expectSlots(parseGhosttyTheme(CATPPUCCIN_MACCHIATO_FIXTURE));

    expect(slots.sourceFormat).toBe('ghostty');
    // Ghostty theme files carry no name field of their own -- same kind of
    // format default the other terminal-style adapters use.
    expect(slots.name).toBe('Ghostty theme');

    // background/foreground/selection-background are BARE hex in this real
    // fixture (no leading '#') -- hand-verified, normalized to '#'-prefixed.
    expect(slots.background).toBe('#24273a');
    expect(slots.foreground).toBe('#cad3f5');
    expect(slots.tokens.selection).toBe('#3a3e53');

    // `palette = N=#hex` entries, hand-verified in file order (these DO
    // carry a leading '#' in the source, unlike the primaries above):
    expect(slots.ansi?.[0]).toBe('#494d64');
    expect(slots.ansi?.[1]).toBe('#ed8796');
    expect(slots.ansi?.[2]).toBe('#a6da95');
    expect(slots.ansi?.[3]).toBe('#eed49f');
    expect(slots.ansi?.[4]).toBe('#8aadf4');
    expect(slots.ansi?.[5]).toBe('#f5bde6');
    expect(slots.ansi?.[6]).toBe('#8bd5ca');
    expect(slots.ansi?.[7]).toBe('#a5adcb');
    expect(slots.ansi?.[8]).toBe('#5b6078');
    expect(slots.ansi?.[9]).toBe('#ed8796');
    expect(slots.ansi?.[10]).toBe('#a6da95');
    expect(slots.ansi?.[11]).toBe('#eed49f');
    expect(slots.ansi?.[12]).toBe('#8aadf4');
    expect(slots.ansi?.[13]).toBe('#f5bde6');
    expect(slots.ansi?.[14]).toBe('#8bd5ca');
    expect(slots.ansi?.[15]).toBe('#b8c0e0');
  });

  it('skips keys it does not map: cursor-color, cursor-text, selection-foreground, split-divider-color', () => {
    // The real fixture carries all four alongside the mapped keys; a clean
    // parse with none of their values leaking into a mapped slot is proof.
    const slots = expectSlots(parseGhosttyTheme(CATPPUCCIN_MACCHIATO_FIXTURE));
    expect(slots.background).not.toBe('#f4dbd6'); // cursor-color
    expect(slots.background).not.toBe('#181926'); // cursor-text
    expect(slots.tokens.selection).not.toBe('#363a4f'); // split-divider-color
  });

  it('accepts a leading-# hex value for background/foreground too', () => {
    const content = `
background = #101010
foreground = #f0f0f0
`;
    const slots = expectSlots(parseGhosttyTheme(content));
    expect(slots.background).toBe('#101010');
    expect(slots.foreground).toBe('#f0f0f0');
  });

  it('skips malformed (non-hex) primaries, leaving those slots unset, while a valid palette entry still succeeds', () => {
    const content = `
background = notahex
foreground = notahex
selection-background = notahex
palette = 0=#494d64
`;
    const slots = expectSlots(parseGhosttyTheme(content));
    expect(slots.background).toBeUndefined();
    expect(slots.foreground).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
    expect(slots.ansi?.[0]).toBe('#494d64');
  });

  it('skips a stray line with no "=", a palette entry with no inner "=", and a malformed palette hex', () => {
    const content = `
not_a_valid_line
palette = justtext
palette = 0=nothex
background = 101010
`;
    const slots = expectSlots(parseGhosttyTheme(content));
    expect(slots.background).toBe('#101010');
    expect(slots.ansi).toBeUndefined();
  });

  it('ignores an out-of-range palette index (16)', () => {
    const content = `
background = 101010
palette = 16=#ffffff
`;
    const slots = expectSlots(parseGhosttyTheme(content));
    expect(slots.ansi).toBeUndefined();
  });

  it('returns a parse error when the file yields no color entries at all', () => {
    const content = `
# a ghostty config with no color settings
font-family = MesloLGS Nerd Font
window-padding-x = 10
`;
    const error = expectError(parseGhosttyTheme(content));
    expect(error.stage).toBe('parse');
    expect(error.message).toBe('no color entries found');
  });
});
