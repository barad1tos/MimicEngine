import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseJetbrainsUiTheme } from './jetbrainsUiTheme';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/ayu-mirage.theme.json', import.meta.url));
const AYU_MIRAGE_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseJetbrainsUiTheme', () => {
  it('maps the real ayu-mirage fixture: chains that resolve get hand-verified hexes, others stay unset', () => {
    const slots = expectSlots(parseJetbrainsUiTheme(AYU_MIRAGE_FIXTURE));

    expect(slots.name).toBe('Ayu Mirage');
    expect(slots.sourceFormat).toBe('jetbrains-ui');
    expect(slots.mode).toBe('dark');
    expect(slots.author).toBe('cloud');

    // Hand-verified against the fixture's `colors` palette by walking each
    // chain in the mapping brief:
    //   canvas   <- ui.*.background "PanelBackground" -> Gray1.5 -> #242936
    //   text     <- ui.*.foreground "ForegroundDefault" -> #CCCAC2
    //   surface1 <- EditorTabs.background "BackgroundDark" -> Gray1.5 -> #242936
    //   surface2 <- Popup.background "PopupBackground" -> Gray1.25 -> #1C212C
    //   border   <- Component.borderColor "ComponentBorder" -> Gray4 -> #445066
    //   focus    <- Component.focusColor literal #FFCC66
    //   accent   <- Component.focusColor literal #FFCC66 (first hit, beats
    //               Button.default.focusedBorderColor and List.selectionBackground)
    //   link     <- Link.activeForeground literal #FFCC66
    expect(slots.tokens.canvas).toBe('#242936');
    expect(slots.tokens.text).toBe('#cccac2');
    expect(slots.tokens.surface1).toBe('#242936');
    expect(slots.tokens.surface2).toBe('#1c212c');
    expect(slots.tokens.border).toBe('#445066');
    expect(slots.tokens.focus).toBe('#ffcc66');
    expect(slots.tokens.accent).toBe('#ffcc66');
    expect(slots.tokens.link).toBe('#ffcc66');

    // Every candidate path for these five is verifiably absent from the
    // fixture (confirmed by grep, not just eyeballing): surface3's only
    // candidate (ActionButton.hoverBackground), textMuted's two candidates
    // (Label.infoForeground / Component.infoForeground), selection's two
    // candidates (List.selectionBackground / EditorPane.selectionBackground
    // — the fixture only has the unrelated wildcard "*".selectionBackground
    // and StatusBar.Breadcrumbs.selectionBackground), and all three status
    // candidates (Label.successForeground / warningForeground /
    // errorForeground — the fixture's only "errorForeground" key lives under
    // the unrelated "Recap" block). These stay unset for M3's later
    // derivation pass, per this adapter's map-only contract.
    expect(slots.tokens.surface3).toBeUndefined();
    expect(slots.tokens.textMuted).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
    expect(slots.tokens.success).toBeUndefined();
    expect(slots.tokens.warning).toBeUndefined();
    expect(slots.tokens.danger).toBeUndefined();
  });

  it('resolves a palette-name reference in a synthetic minimal theme', () => {
    const content = JSON.stringify({
      name: 'Synthetic',
      dark: true,
      colors: { bg: '#111213' },
      ui: { '*': { background: 'bg' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.tokens.canvas).toBe('#111213');
  });

  it('follows a chained palette reference (name -> name -> hex)', () => {
    const content = JSON.stringify({
      name: 'Chained',
      dark: true,
      colors: { bg: 'bgAlias', bgAlias: '#0a0b0c' },
      ui: { '*': { background: 'bg' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.tokens.canvas).toBe('#0a0b0c');
  });

  it('treats a cyclic palette chain as absent instead of hanging', () => {
    const content = JSON.stringify({
      name: 'Cyclic',
      dark: true,
      colors: { a: 'b', b: 'a' },
      ui: { '*': { background: 'a' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.tokens.canvas).toBeUndefined();
  });

  it('composites a partial-alpha color over the already-resolved canvas', () => {
    const content = JSON.stringify({
      name: 'Translucent',
      dark: true,
      ui: { '*': { background: '#101010' }, Component: { borderColor: '#ffffff80' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    // #ffffff over #101010 at alpha 0x80/255 (~0.502): channel = round(255*a + 16*(1-a)) = 136 = 0x88.
    expect(slots.tokens.border).toBe('#888888');
  });

  it('treats a fully-transparent color as absent, not as a slot value', () => {
    const content = JSON.stringify({
      name: 'FullyTransparent',
      dark: true,
      ui: { '*': { background: '#101010' }, Component: { borderColor: '#00000000' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.tokens.border).toBeUndefined();
  });

  it('advances past a present-but-unusable first candidate to a usable second candidate', () => {
    const content = JSON.stringify({
      name: 'Fallthrough',
      dark: false,
      ui: {
        '*': { background: '#101010' },
        // First candidate for border (Component.borderColor) EXISTS but is
        // fully transparent, i.e. unusable per the composite semantics.
        // Second candidate (Borders.color) holds a real opaque value.
        Component: { borderColor: '#00000000' },
        Borders: { color: '#223344' },
      },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    // Semantics-pinning case: under "stop at the first ui key that merely
    // exists" (a reading the brief doesn't rule out), Component.borderColor
    // being present would end the chain right there and border would stay
    // undefined. This adapter instead keeps trying candidates until one
    // resolves to a usable color, so border falls through to Borders.color.
    expect(slots.tokens.border).toBe('#223344');
  });

  it('resolves a candidate expressed as nested-object-then-flat-dotted-key (third ui key form)', () => {
    const content = JSON.stringify({
      name: 'NestedThenFlatDotted',
      dark: true,
      ui: {
        '*': { background: '#101010' },
        // accent's first candidate, Component.focusColor, is absent
        // entirely (no "Component" key at all). Its second candidate,
        // Button.default.focusedBorderColor, is expressed the way the real
        // ayu-mirage fixture expresses it: one level of nesting ("Button"),
        // then a single flat key with a literal dot in it
        // ("default.focusedBorderColor") rather than a further nested
        // object. lookupPath must resolve this third form, not just the
        // fully-flat and fully-nested forms the other tests exercise.
        Button: { 'default.focusedBorderColor': '#3399ff' },
      },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.tokens.accent).toBe('#3399ff');
  });

  it('leaves author unset when the theme JSON has no "author" field', () => {
    const content = JSON.stringify({ name: 'NoAuthor', ui: { '*': { background: '#101010' } } });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(Object.hasOwn(slots, 'author')).toBe(false);
  });

  it('leaves author unset when "author" is present but empty', () => {
    const content = JSON.stringify({
      name: 'EmptyAuthor',
      author: '',
      ui: { '*': { background: '#101010' } },
    });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(Object.hasOwn(slots, 'author')).toBe(false);
  });

  it('leaves mode unset when "dark" is not a boolean', () => {
    const content = JSON.stringify({ name: 'NoMode', ui: { '*': { background: '#101010' } } });

    const slots = expectSlots(parseJetbrainsUiTheme(content));
    expect(slots.mode).toBeUndefined();
  });

  it('returns a parse error for malformed JSON', () => {
    const error = expectError(parseJetbrainsUiTheme('{ "name": "Broken", '));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when the root is not a JSON object', () => {
    const error = expectError(parseJetbrainsUiTheme('[1, 2, 3]'));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when "name" is missing', () => {
    const error = expectError(parseJetbrainsUiTheme(JSON.stringify({ ui: { '*': {} } })));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when "ui" is missing', () => {
    const error = expectError(parseJetbrainsUiTheme(JSON.stringify({ name: 'NoUi' })));
    expect(error.stage).toBe('parse');
  });
});
