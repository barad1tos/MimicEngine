// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseJetbrainsEditorScheme } from './jetbrainsEditorScheme';

// `new URL(relative, import.meta.url)` resolves against happy-dom's fake
// `http://localhost:3000` window location instead of import.meta.url's real
// `file:` base under Vitest's happy-dom environment (verified empirically --
// the same `new URL()` call behaves correctly in a `node`-environment test
// file). path.join + fileURLToPath sidesteps that entirely.
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/ayu-mirage-editor.icls',
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

describe('parseJetbrainsEditorScheme', () => {
  it('maps the real ayu-mirage-editor fixture: hand-verified hexes, no ANSI-named console attributes present', () => {
    const slots = expectSlots(parseJetbrainsEditorScheme(AYU_MIRAGE_FIXTURE));

    expect(slots.name).toBe('Ayu Islands Mirage');
    expect(slots.sourceFormat).toBe('jetbrains-editor');

    // Hand-verified against the fixture's <colors>/<attributes> blocks:
    //   canvas    <- attributes.TEXT.BACKGROUND "1F2430" (opaque)         -> #1f2430
    //   text      <- attributes.TEXT.FOREGROUND "CCCAC2" (opaque)         -> #cccac2
    //   surface1  <- colors.CARET_ROW_COLOR "FFCC661A" (RGBA hex, alpha
    //                0x1A/255) composited over canvas #1f2430 (31,36,48)  -> #363536
    //   selection <- colors.SELECTION_BACKGROUND "409FFF40" (alpha
    //                0x40/255) composited over the same canvas            -> #274364
    //   textMuted <- colors.LINE_NUMBERS_COLOR "8A9199" (opaque)          -> #8a9199
    //   border    <- colors.TEARLINE_COLOR "282C34" (opaque, first
    //                candidate present, INDENT_GUIDE fallback unused)     -> #282c34
    expect(slots.tokens.canvas).toBe('#1f2430');
    expect(slots.tokens.text).toBe('#cccac2');
    expect(slots.tokens.surface1).toBe('#363536');
    expect(slots.tokens.selection).toBe('#274364');
    expect(slots.tokens.textMuted).toBe('#8a9199');
    expect(slots.tokens.border).toBe('#282c34');

    // Confirmed by grep: the fixture's only CONSOLE_* keys are
    // CONSOLE_BACKGROUND_KEY, CONSOLE_ERROR_OUTPUT, CONSOLE_NORMAL_OUTPUT,
    // CONSOLE_RANGE_TO_EXECUTE, CONSOLE_SYSTEM_OUTPUT, CONSOLE_USER_INPUT --
    // none of the 16 indexed ANSI console-color attributes
    // (CONSOLE_BLACK_OUTPUT..CONSOLE_WHITE_OUTPUT). ansi stays entirely unset.
    expect(slots.ansi).toBeUndefined();
  });

  it('extracts CONSOLE_*_OUTPUT attributes into the indexed ansi array, sparse gaps stay undefined', () => {
    const content = `<scheme name="Synthetic">
      <attributes>
        <option name="CONSOLE_BLACK_OUTPUT"><value><option name="FOREGROUND" value="000000" /></value></option>
        <option name="CONSOLE_RED_OUTPUT"><value><option name="FOREGROUND" value="ff0000" /></value></option>
        <option name="CONSOLE_WHITE_OUTPUT"><value><option name="FOREGROUND" value="ffffff" /></value></option>
      </attributes>
    </scheme>`;

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.ansi).toHaveLength(16);
    expect(slots.ansi?.[0]).toBe('#000000');
    expect(slots.ansi?.[1]).toBe('#ff0000');
    expect(slots.ansi?.[15]).toBe('#ffffff');
    expect(slots.ansi?.[2]).toBeUndefined();
  });

  it('falls back from TEARLINE_COLOR to INDENT_GUIDE for border when TEARLINE_COLOR is absent', () => {
    const content = `<scheme name="Synthetic">
      <colors>
        <option name="INDENT_GUIDE" value="223344" />
      </colors>
    </scheme>`;

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.tokens.border).toBe('#223344');
  });

  it('falls back from attributes.TEXT.BACKGROUND to a top-level colors option BACKGROUND for canvas', () => {
    const content = `<scheme name="Synthetic">
      <colors>
        <option name="BACKGROUND" value="101010" />
      </colors>
    </scheme>`;

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.tokens.canvas).toBe('#101010');
  });

  it('treats a fully-transparent color as absent, not as a slot value', () => {
    const content = `<scheme name="Synthetic">
      <attributes>
        <option name="TEXT"><value><option name="BACKGROUND" value="10101000" /></value></option>
      </attributes>
    </scheme>`;

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.tokens.canvas).toBeUndefined();
  });

  it('leaves a translucent candidate unresolved when no canvas is known yet to composite over', () => {
    const content = `<scheme name="Synthetic">
      <colors>
        <option name="SELECTION_BACKGROUND" value="40404040" />
      </colors>
    </scheme>`;

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.tokens.canvas).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
  });

  it('leaves tokens with no matching source key unset for later derivation', () => {
    const content = '<scheme name="Empty"></scheme>';

    const slots = expectSlots(parseJetbrainsEditorScheme(content));
    expect(slots.tokens.canvas).toBeUndefined();
    expect(slots.tokens.text).toBeUndefined();
    expect(slots.tokens.surface1).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
    expect(slots.tokens.textMuted).toBeUndefined();
    expect(slots.tokens.border).toBeUndefined();
    expect(slots.ansi).toBeUndefined();
  });

  it('returns a parse error for malformed XML', () => {
    const error = expectError(parseJetbrainsEditorScheme('<scheme><colors></scheme>'));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when the scheme "name" attribute is missing', () => {
    const error = expectError(parseJetbrainsEditorScheme('<scheme><colors></colors></scheme>'));
    expect(error.stage).toBe('parse');
  });
});
