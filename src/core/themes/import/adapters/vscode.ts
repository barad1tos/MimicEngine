// VS Code theme JSON adapter. Maps the file's flat, dotted `colors` object
// (workbench colors) onto ThemeSlots via first-hit-wins candidate key lists;
// `tokenColors` (syntax highlighting) is ignored entirely. A candidate that
// doesn't resolve to a usable opaque color (missing key, fully transparent)
// falls through to the next candidate, and an exhausted list leaves the slot
// unset for later derivation — this adapter only maps, it never derives.

import { parseCssColor, toHex, type RgbaColor } from '../../../color/parseColor';
import { THEME_TOKEN_NAMES, type ThemeTokenName, type ThemeTokens } from '../../themeTypes';
import type { ImportError, ThemeSlots } from '../importTypes';
import { stripJsonc } from '../jsonc';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

// Real VS Code theme JSON files rarely carry their own "name" — the label
// users see comes from the extension's package.json `contributes.themes`
// entry instead (confirmed against the ayu-mirage fixture, which has no
// top-level "name" key at all). Default like the terminal-format adapters
// do for sources that never carry a name of their own.
const DEFAULT_NAME = 'VS Code theme';

function parseError(message: string): ImportError {
  return { stage: 'parse', message };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Standard "over" alpha compositing of a translucent foreground onto an opaque canvas. */
function compositeOverCanvas(foreground: RgbaColor, canvas: RgbaColor): RgbaColor {
  return {
    r: foreground.r * foreground.a + canvas.r * (1 - foreground.a),
    g: foreground.g * foreground.a + canvas.g * (1 - foreground.a),
    b: foreground.b * foreground.a + canvas.b * (1 - foreground.a),
    a: 1,
  };
}

/**
 * Turns a raw color literal into an opaque hex slot value. Fully transparent
 * yields nothing (absent). A partial-alpha value (VS Code's common
 * `#RRGGBBAA` selections) composites over `canvasRgba` when one is already
 * known; without a canvas to composite against, it's also absent rather than
 * guessed.
 */
function resolveOpaqueHex(rawColor: string, canvasRgba: RgbaColor | undefined): string | undefined {
  const rgba = parseCssColor(rawColor);
  if (!rgba || rgba.a === 0) return undefined;
  if (rgba.a === 1) return toHex(rgba);
  if (!canvasRgba) return undefined;
  return toHex(compositeOverCanvas(rgba, canvasRgba));
}

function resolveSlotColor(
  keys: readonly string[],
  colors: JsonObject,
  canvasRgba: RgbaColor | undefined,
): string | undefined {
  for (const key of keys) {
    const raw = colors[key];
    if (typeof raw !== 'string') continue;

    const hex = resolveOpaqueHex(raw, canvasRgba);
    if (hex !== undefined) return hex;
  }
  return undefined;
}

// First-hit-wins candidate key lists per slot, from the approved mapping.
const SLOT_KEYS: Readonly<Record<ThemeTokenName, readonly string[]>> = {
  canvas: ['editor.background'],
  text: ['editor.foreground', 'foreground'],
  surface1: ['sideBar.background', 'editorGroupHeader.tabsBackground'],
  surface2: ['activityBar.background', 'panel.background'],
  surface3: ['editorWidget.background', 'dropdown.background'],
  textMuted: ['descriptionForeground', 'editorLineNumber.foreground'],
  border: ['panel.border', 'editorGroup.border', 'contrastBorder'],
  selection: ['editor.selectionBackground'],
  focus: ['focusBorder'],
  accent: ['focusBorder', 'button.background'],
  link: ['textLink.foreground'],
  success: ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground'],
  warning: ['editorWarning.foreground', 'terminal.ansiYellow'],
  danger: ['editorError.foreground', 'terminal.ansiRed'],
};

function resolveMode(type: JsonValue | undefined): 'dark' | 'light' | undefined {
  return type === 'dark' || type === 'light' ? type : undefined;
}

export function parseVscodeTheme(content: string): ThemeSlots | ImportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(content));
  } catch (cause) {
    return parseError(`invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!isJsonObject(parsed)) return parseError('theme root is not a JSON object');

  const { name, colors: colorsRaw, type } = parsed;
  if (!isJsonObject(colorsRaw)) return parseError('theme is missing a "colors" object');

  const colors = colorsRaw;

  const canvasHex = resolveSlotColor(SLOT_KEYS.canvas, colors, undefined);
  const canvasRgba = canvasHex !== undefined ? (parseCssColor(canvasHex) ?? undefined) : undefined;

  const tokens: Partial<ThemeTokens> = {};
  if (canvasHex !== undefined) tokens.canvas = canvasHex;
  for (const tokenName of THEME_TOKEN_NAMES) {
    if (tokenName === 'canvas') continue;
    const hex = resolveSlotColor(SLOT_KEYS[tokenName], colors, canvasRgba);
    if (hex !== undefined) tokens[tokenName] = hex;
  }

  const mode = resolveMode(type);

  return {
    name: typeof name === 'string' && name.length > 0 ? name : DEFAULT_NAME,
    sourceFormat: 'vscode',
    tokens,
    ...(mode !== undefined ? { mode } : {}),
  };
}
