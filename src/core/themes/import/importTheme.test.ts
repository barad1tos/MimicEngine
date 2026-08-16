// @vitest-environment happy-dom
// happy-dom is required file-wide: two of the five e2e fixtures below
// (icls, iterm) route through DOMParser in their adapters. `new URL(relative,
// import.meta.url)` resolves against happy-dom's fake `http://localhost:3000`
// window location instead of import.meta.url's real `file:` base under this
// environment (established in adapters/iterm.test.ts and
// adapters/jetbrainsEditorScheme.test.ts) -- path.join + fileURLToPath
// sidesteps it, so every fixture load below uses that pattern uniformly, not
// just the XML ones.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_TOKEN_NAMES } from '../themeTypes';
import { importTheme } from './importTheme';
import type { ImportResult } from './importTypes';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixture(fileName: string): string {
  return readFileSync(join(FIXTURES_DIR, fileName), 'utf8');
}

const JETBRAINS_UI_FIXTURE = readFixture('ayu-mirage.theme.json');
const JETBRAINS_EDITOR_FIXTURE = readFixture('ayu-mirage-editor.icls');
const VSCODE_FIXTURE = readFixture('vscode-ayu-mirage.json');
const ITERM_FIXTURE = readFixture('ayu-mirage.itermcolors');
const ALACRITTY_FIXTURE = readFixture('ayu-mirage.alacritty.toml');
const KITTY_FIXTURE = readFixture('ayu-mirage.kitty.conf');

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function expectSuccess(result: ImportResult): Extract<ImportResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got error: ${result.error.message}`);
  return result;
}

function expectFailure(result: ImportResult): Extract<ImportResult, { ok: false }> {
  if (result.ok) throw new Error('expected an error result, got success');
  return result;
}

describe('importTheme', () => {
  describe('end-to-end per format family', () => {
    const cases: readonly [name: string, content: string, sourceFormat: string][] = [
      ['jetbrains-ui', JETBRAINS_UI_FIXTURE, 'jetbrains-ui'],
      ['jetbrains-editor (.icls)', JETBRAINS_EDITOR_FIXTURE, 'jetbrains-editor'],
      ['vscode', VSCODE_FIXTURE, 'vscode'],
      ['iterm', ITERM_FIXTURE, 'iterm'],
      ['alacritty', ALACRITTY_FIXTURE, 'alacritty'],
    ];

    it.each(cases)(
      'imports a real %s fixture into a 14-token opaque theme',
      (_label, content, sourceFormat) => {
        const result = expectSuccess(importTheme(content));

        expect(result.sourceFormat).toBe(sourceFormat);
        expect(result.theme.id).toBe('');
        expect(Object.keys(result.theme.tokens)).toHaveLength(THEME_TOKEN_NAMES.length);
        for (const tokenName of THEME_TOKEN_NAMES) {
          expect(result.theme.tokens[tokenName]).toMatch(HEX_COLOR_PATTERN);
        }
        expect(Array.isArray(result.derivedTokens)).toBe(true);
        for (const tokenName of result.derivedTokens) {
          expect(THEME_TOKEN_NAMES).toContain(tokenName);
        }
      },
    );
  });

  it('is deterministic: two runs on the same content produce equal results and identically ordered derivedTokens', () => {
    // jetbrains-ui leaves several tokens for derivation (surface3, textMuted,
    // success, warning, danger, selection per its adapter test), so
    // derivedTokens is non-empty here -- a stronger check than a fixture
    // that derives nothing.
    const first = importTheme(JETBRAINS_UI_FIXTURE);
    const second = importTheme(JETBRAINS_UI_FIXTURE);

    expect(second).toEqual(first);

    const firstOk = expectSuccess(first);
    const secondOk = expectSuccess(second);
    expect(secondOk.derivedTokens).toEqual(firstOk.derivedTokens);
  });

  it('carries the source-declared author through the full pipeline for jetbrains-ui', () => {
    // The real ayu-mirage.theme.json fixture declares "author": "cloud" --
    // this is the only format whose adapter reads a top-level author field
    // (see adapters/jetbrainsUiTheme.test.ts), so it's the one that must
    // survive detect -> parse -> derive -> validate end to end.
    const result = expectSuccess(importTheme(JETBRAINS_UI_FIXTURE));
    expect(result.theme.author).toBe('cloud');
  });

  it('leaves author unset end to end for a format whose spec has no author field', () => {
    // kitty.conf has no author concept at all; the real ayu-mirage fixture
    // has enough color entries (background/foreground plus ANSI blue for
    // accent) to import successfully without ever touching author.
    const result = expectSuccess(importTheme(KITTY_FIXTURE));
    expect(Object.hasOwn(result.theme, 'author')).toBe(false);
  });

  it('preserves a source-provided token verbatim through derivation (monotonicity)', () => {
    // vscode's ayu-mirage fixture supplies canvas directly (editor.background
    // -> #242936, hand-verified in adapters/vscode.test.ts); a gap-fill pass
    // must never touch a token the source already provided.
    const result = expectSuccess(importTheme(VSCODE_FIXTURE));

    expect(result.theme.tokens.canvas).toBe('#242936');
    expect(result.derivedTokens).not.toContain('canvas');
  });

  it('surfaces a detect-stage error for unrecognized garbage input', () => {
    const result = expectFailure(importTheme('this is not a theme file at all, just some prose.'));
    expect(result.error).toEqual({ stage: 'detect', message: 'unrecognized theme format' });
  });

  it('surfaces a parse-stage error when the dispatched adapter rejects structurally broken JSON', () => {
    // Syntactically valid JSON -- detectFormat only requires a top-level "ui"
    // object to classify this as jetbrains-ui -- but structurally broken for
    // that format: parseJetbrainsUiTheme requires a "name" field and, absent
    // one, itself returns a stage:'parse' error (pinned in
    // adapters/jetbrainsUiTheme.test.ts: "returns a parse error when \"name\"
    // is missing"). Detection and parsing run the identical JSON.parse over
    // the identical string, so a JSON.parse *syntax* failure can never reach
    // this far -- it would already have failed detection (see the garbage
    // case above) -- which is why "broken" here means adapter-structurally
    // invalid rather than unparsable as JSON text.
    const content = JSON.stringify({ ui: { 'Component.background': '#112233' } });

    const result = expectFailure(importTheme(content));
    expect(result.error.stage).toBe('parse');
    expect(result.error.message).toBe('theme is missing a name');
  });

  it('surfaces a derive-stage error for a kitty file with no canvas/text primaries', () => {
    // Only ANSI entries, no background/foreground -- parseKittyTheme succeeds
    // (it has color entries), but deriveGaps has nothing to seed canvas/text
    // from.
    const content = ['color0 #191e2a', 'color4 #6dcbfa'].join('\n');

    const result = expectFailure(importTheme(content));
    expect(result.error).toEqual({
      stage: 'derive',
      message: 'missing canvas/text primaries: canvas, text',
    });
  });

  it('surfaces a validate-stage error for a crafted vscode theme with low text/canvas contrast', () => {
    // canvas and text are both near-black -- every other token derives
    // cleanly (accent seeds from focusBorder, so derivation never fails),
    // but the text/canvas pair can't clear the 4.5:1 floor.
    const content = JSON.stringify({
      type: 'dark',
      colors: {
        'editor.background': '#141414',
        'editor.foreground': '#1a1a1a',
        focusBorder: '#3399ff',
      },
    });

    const result = expectFailure(importTheme(content));
    expect(result.error.stage).toBe('validate');
    expect(result.error.message).toMatch(/^text\/canvas contrast/);
  });
});
