// JetBrains editor color scheme (.icls) adapter. Maps the root <scheme>'s
// flat <colors> options and the nested <attributes> "TEXT" entry's
// FOREGROUND/BACKGROUND onto ThemeSlots. Color values in this format are
// bare hex without a leading '#' (e.g. value="1f2430"), sometimes with a
// trailing alpha byte (RRGGBBAA, e.g. "409FFF40"); normalized to a '#'-
// prefixed literal before going through the shared resolveOpaqueHex, which
// already treats an 8-digit hex the same way (RRGGBBAA). A candidate that
// doesn't resolve to a usable opaque color (missing key, fully transparent,
// translucent with no canvas yet to composite over) falls through to the
// next candidate where the mapping defines one, otherwise the slot stays
// unset for later derivation -- this adapter only maps, it never derives.
//
// The 16-slot ansi array has two real-world sources per index: the console
// highlighter's CONSOLE_*_OUTPUT attributes (nested under <attributes>, one
// per ANSI color) and the terminal emulator's TERMINAL_COLOR_N options (flat
// under <colors>, already numbered 0-15). Most real schemes -- including the
// ayu-mirage fixture -- populate only TERMINAL_COLOR_N and never touch the
// console attributes, so CONSOLE_* alone would leave ansi silently empty for
// the common case. Per-index fallback: CONSOLE_* wins when present, else
// TERMINAL_COLOR_N.

import { parseCssColor, type RgbaColor } from '../../../color/parseColor';
import type { ThemeTokens } from '../../themeTypes';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseError, resolveOpaqueHex } from '../resolveColor';

// IntelliJ Platform's console highlighter attribute names for the 16
// indexed ANSI colors, in ANSI order (0=black .. 7=white/gray, 8=bright
// black .. 15=bright white). Verified against JetBrains/intellij-community's
// platform/platform-resources/src/DefaultColorSchemesManager.xml -- index 7
// is "GRAY" and index 8 is "DARKGRAY", not "WHITE"/"BLACK_BRIGHT".
const ANSI_ATTRIBUTE_NAMES: readonly string[] = [
  'CONSOLE_BLACK_OUTPUT',
  'CONSOLE_RED_OUTPUT',
  'CONSOLE_GREEN_OUTPUT',
  'CONSOLE_YELLOW_OUTPUT',
  'CONSOLE_BLUE_OUTPUT',
  'CONSOLE_MAGENTA_OUTPUT',
  'CONSOLE_CYAN_OUTPUT',
  'CONSOLE_GRAY_OUTPUT',
  'CONSOLE_DARKGRAY_OUTPUT',
  'CONSOLE_RED_BRIGHT_OUTPUT',
  'CONSOLE_GREEN_BRIGHT_OUTPUT',
  'CONSOLE_YELLOW_BRIGHT_OUTPUT',
  'CONSOLE_BLUE_BRIGHT_OUTPUT',
  'CONSOLE_MAGENTA_BRIGHT_OUTPUT',
  'CONSOLE_CYAN_BRIGHT_OUTPUT',
  'CONSOLE_WHITE_OUTPUT',
];

function normalizeHex(rawValue: string): string {
  return `#${rawValue}`;
}

function directChild(parent: Element | null, selector: string): Element | null {
  return parent?.querySelector(`:scope > ${selector}`) ?? null;
}

/** A flat `<colors><option name="X" value="Y"/></colors>` entry. */
function colorOption(colors: Element | null, name: string): string | undefined {
  const value = directChild(colors, `option[name="${name}"]`)?.getAttribute('value');
  return value === null || value === undefined ? undefined : normalizeHex(value);
}

/** A nested `<attributes><option name="X"><value><option name="CHANNEL" value="Y"/></value></option></attributes>` entry. */
function attributeChannel(
  attributes: Element | null,
  attributeName: string,
  channel: 'FOREGROUND' | 'BACKGROUND',
): string | undefined {
  const attributeOption = directChild(attributes, `option[name="${attributeName}"]`);
  const value = attributeOption
    ?.querySelector(`:scope > value > option[name="${channel}"]`)
    ?.getAttribute('value');
  return value === null || value === undefined ? undefined : normalizeHex(value);
}

function resolveFirstUsable(
  candidates: readonly (string | undefined)[],
  canvasRgba: RgbaColor | undefined,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const hex = resolveOpaqueHex(candidate, canvasRgba);
    if (hex !== undefined) return hex;
  }
  return undefined;
}

function resolveAnsi(
  attributes: Element | null,
  colors: Element | null,
  canvasRgba: RgbaColor | undefined,
): (string | undefined)[] | undefined {
  const ansi = ANSI_ATTRIBUTE_NAMES.map((attributeName, index) =>
    resolveFirstUsable(
      [
        attributeChannel(attributes, attributeName, 'FOREGROUND'),
        colorOption(colors, `TERMINAL_COLOR_${String(index)}`),
      ],
      canvasRgba,
    ),
  );
  return ansi.some((hex) => hex !== undefined) ? ansi : undefined;
}

export function parseJetbrainsEditorScheme(content: string): ThemeSlots | ImportError {
  const doc = new DOMParser().parseFromString(content, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return parseError('malformed XML');
  }

  const scheme = doc.documentElement;
  const name = scheme.getAttribute('name');
  if (name === null || name.length === 0) return parseError('scheme is missing a "name" attribute');

  const colors = directChild(scheme, 'colors');
  const attributes = directChild(scheme, 'attributes');

  const canvasHex = resolveFirstUsable(
    [attributeChannel(attributes, 'TEXT', 'BACKGROUND'), colorOption(colors, 'BACKGROUND')],
    undefined,
  );
  const canvasRgba = canvasHex !== undefined ? (parseCssColor(canvasHex) ?? undefined) : undefined;

  const tokens: Partial<ThemeTokens> = {};
  if (canvasHex !== undefined) tokens.canvas = canvasHex;

  const textHex = resolveFirstUsable(
    [attributeChannel(attributes, 'TEXT', 'FOREGROUND')],
    canvasRgba,
  );
  if (textHex !== undefined) tokens.text = textHex;

  const surface1Hex = resolveFirstUsable([colorOption(colors, 'CARET_ROW_COLOR')], canvasRgba);
  if (surface1Hex !== undefined) tokens.surface1 = surface1Hex;

  const selectionHex = resolveFirstUsable(
    [colorOption(colors, 'SELECTION_BACKGROUND')],
    canvasRgba,
  );
  if (selectionHex !== undefined) tokens.selection = selectionHex;

  const textMutedHex = resolveFirstUsable([colorOption(colors, 'LINE_NUMBERS_COLOR')], canvasRgba);
  if (textMutedHex !== undefined) tokens.textMuted = textMutedHex;

  const borderHex = resolveFirstUsable(
    [colorOption(colors, 'TEARLINE_COLOR'), colorOption(colors, 'INDENT_GUIDE')],
    canvasRgba,
  );
  if (borderHex !== undefined) tokens.border = borderHex;

  const ansi = resolveAnsi(attributes, colors, canvasRgba);

  return {
    name,
    sourceFormat: 'jetbrains-editor',
    tokens,
    ...(ansi !== undefined ? { ansi } : {}),
  };
}
