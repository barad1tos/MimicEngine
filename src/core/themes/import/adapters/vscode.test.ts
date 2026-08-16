import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseVscodeTheme } from './vscode';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/vscode-ayu-mirage.json', import.meta.url));
const AYU_MIRAGE_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseVscodeTheme', () => {
  it('maps the real ayu-mirage fixture: every chain hand-verified against the colors object', () => {
    const slots = expectSlots(parseVscodeTheme(AYU_MIRAGE_FIXTURE));

    expect(slots.sourceFormat).toBe('vscode');
    expect(slots.mode).toBe('dark');
    // Real VS Code theme JSON carries no top-level "name" (the label lives in
    // the extension's package.json instead) -- confirmed by reading this
    // fixture's keys, which are exactly type/colors/tokenColors/
    // semanticHighlighting/semanticTokenColors. Falls back to the same kind
    // of format default the terminal adapters use.
    expect(slots.name).toBe('VS Code theme');

    // Hand-verified against the fixture's `colors` object by walking each
    // chain in the mapping brief (first candidate hit in every case):
    //   canvas    <- editor.background            #242936
    //   text      <- editor.foreground             #cccac2
    //   surface1  <- sideBar.background             #1f2430
    //   surface2  <- activityBar.background          #1f2430
    //   surface3  <- editorWidget.background          #282e3b
    //   textMuted <- descriptionForeground              #707a8c
    //   border    <- panel.border                        #171b24
    //   accent    <- focusBorder                          #ffcc66
    //   link      <- textLink.foreground                   #ffcc66
    //   focus     <- focusBorder                            #ffcc66
    //   success   <- terminal.ansiGreen                      #87d96c
    //   warning   <- editorWarning.foreground                 #ffcc66
    //   danger    <- editorError.foreground                    #ff6666
    expect(slots.tokens.canvas).toBe('#242936');
    expect(slots.tokens.text).toBe('#cccac2');
    expect(slots.tokens.surface1).toBe('#1f2430');
    expect(slots.tokens.surface2).toBe('#1f2430');
    expect(slots.tokens.surface3).toBe('#282e3b');
    expect(slots.tokens.textMuted).toBe('#707a8c');
    expect(slots.tokens.border).toBe('#171b24');
    expect(slots.tokens.accent).toBe('#ffcc66');
    expect(slots.tokens.link).toBe('#ffcc66');
    expect(slots.tokens.focus).toBe('#ffcc66');
    expect(slots.tokens.success).toBe('#87d96c');
    expect(slots.tokens.warning).toBe('#ffcc66');
    expect(slots.tokens.danger).toBe('#ff6666');

    // selection <- editor.selectionBackground "#409fff40", translucent, so it
    // composites over the resolved canvas #242936 (36,41,54). Hand-computed:
    //   alpha = 0x40/255 = 64/255
    //   r = round((64*64 + 36*191) / 255) = round(10972/255) = round(43.027) = 43 = 0x2b
    //   g = round((159*64 + 41*191) / 255) = round(18007/255) = round(70.616) = 71 = 0x47
    //   b = round((255*64 + 54*191) / 255) = round(26634/255) = round(104.447) = 104 = 0x68
    expect(slots.tokens.selection).toBe('#2b4768');
  });

  it('composites a translucent selection over a synthetic canvas (brief-literal case)', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: {
        'editor.background': '#101010',
        'editor.foreground': '#f0f0f0',
        'editor.selectionBackground': '#ffffff40',
      },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    // #ffffff over #101010 (16,16,16) at alpha 0x40/255 (~0.251): every
    // channel is round(255*a + 16*(1-a)) = round((255*64 + 16*191)/255) =
    // round(19376/255) = round(75.984) = 76 = 0x4c.
    expect(slots.tokens.selection).toBe('#4c4c4c');
  });

  it('accepts JSONC input with a comment before the color object is parsed', () => {
    const content = `{
      // ayu-inspired synthetic fixture, JSONC comment must be stripped
      "type": "dark",
      "colors": {
        "editor.background": "#101010", // trailing comment on a value line
        "editor.foreground": "#f0f0f0",
      },
    }`;

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.canvas).toBe('#101010');
    expect(slots.tokens.text).toBe('#f0f0f0');
  });

  it('uses the "name" field when the theme JSON provides one', () => {
    const content = JSON.stringify({
      name: 'Custom VS Code Theme',
      type: 'light',
      colors: { 'editor.background': '#ffffff' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.name).toBe('Custom VS Code Theme');
    expect(slots.mode).toBe('light');
  });

  it('falls back to "foreground" when "editor.foreground" is absent', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#101010', foreground: '#e0e0e0' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.text).toBe('#e0e0e0');
  });

  it('advances past a present-but-unusable first candidate to a usable second candidate', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: {
        'editor.background': '#101010',
        // First candidate for border (panel.border) EXISTS but is fully
        // transparent, i.e. unusable per the composite semantics. Second
        // candidate (editorGroup.border) holds a real opaque value.
        'panel.border': '#00000000',
        'editorGroup.border': '#223344',
      },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.border).toBe('#223344');
  });

  it('treats a fully-transparent sole candidate as absent, not as a slot value', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#101010', 'textLink.foreground': '#00000000' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.link).toBeUndefined();
  });

  it('leaves a translucent candidate unresolved when no canvas is known yet to composite over', () => {
    const content = JSON.stringify({
      type: 'dark',
      // No "editor.background", so canvas never resolves and there is
      // nothing to composite border's translucent value against.
      colors: { 'panel.border': '#22334480' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.canvas).toBeUndefined();
    expect(slots.tokens.border).toBeUndefined();
  });

  it('leaves tokens with no matching candidate unset for later derivation', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#101010' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.surface1).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
    expect(slots.tokens.success).toBeUndefined();
    expect(slots.tokens.warning).toBeUndefined();
    expect(slots.tokens.danger).toBeUndefined();
  });

  it('leaves mode unset when "type" is neither "dark" nor "light"', () => {
    const content = JSON.stringify({
      type: 'high-contrast',
      colors: { 'editor.background': '#101010' },
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.mode).toBeUndefined();
  });

  it('leaves mode unset when "type" is absent', () => {
    const content = JSON.stringify({ colors: { 'editor.background': '#101010' } });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.mode).toBeUndefined();
  });

  it('ignores tokenColors entirely', () => {
    const content = JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#101010' },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#ff00ff' } }],
    });

    const slots = expectSlots(parseVscodeTheme(content));
    expect(slots.tokens.canvas).toBe('#101010');
  });

  it('returns a parse error for malformed JSON', () => {
    const error = expectError(parseVscodeTheme('{ "type": "dark", '));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when the root is not a JSON object', () => {
    const error = expectError(parseVscodeTheme('[1, 2, 3]'));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when "colors" is missing', () => {
    const error = expectError(parseVscodeTheme(JSON.stringify({ type: 'dark' })));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when "colors" is not a JSON object', () => {
    const error = expectError(parseVscodeTheme(JSON.stringify({ type: 'dark', colors: [] })));
    expect(error.stage).toBe('parse');
  });
});
