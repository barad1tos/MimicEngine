// JetBrains UI theme (.theme.json) adapter. Maps the file's `ui` block,
// resolved through its named `colors` palette, onto ThemeSlots. First-hit-
// wins across each slot's candidate path list; a candidate that doesn't
// resolve to a usable opaque color (missing key, broken palette chain, fully
// transparent value) falls through to the next candidate, and an exhausted
// list leaves the slot unset for later derivation — this adapter only maps,
// it never derives.

import { parseCssColor, type RgbaColor } from '../../../color/parseColor';
import { THEME_TOKEN_NAMES, type ThemeTokenName, type ThemeTokens } from '../../themeTypes';
import type { ImportError, ThemeSlots } from '../importTypes';
import { stripJsonc } from '../jsonc';
import {
  isJsonObject,
  parseError,
  resolveOpaqueHex,
  type JsonObject,
  type JsonValue,
} from '../resolveColor';

const MAX_PALETTE_HOPS = 8;

/**
 * Looks up a dotted path inside a JSON object whose segments may be nested
 * objects, a single flat key with literal dots, or a mix of both at
 * different depths (JetBrains UI theme JSON uses all three conventions,
 * sometimes in the same subtree — e.g. `Button.default.focusedBorderColor`
 * is one flat key nested one level under `Button`). At each level, the full
 * remaining path is tried as a literal key before falling back to a
 * single-segment descent.
 */
function lookupPath(
  node: JsonValue | undefined,
  segments: readonly string[],
): JsonValue | undefined {
  if (segments.length === 0) return node;
  if (!isJsonObject(node)) return undefined;

  const fullKey = segments.join('.');
  if (fullKey in node) return node[fullKey];

  const [head, ...rest] = segments;
  if (head === undefined) return undefined;
  return lookupPath(node[head], rest);
}

/**
 * Resolves a `colors` palette entry that may chain through other named
 * entries (e.g. `BackgroundDark: "Gray1.5"`) to its final literal color
 * string. Bounded by MAX_PALETTE_HOPS and a seen-set so a cycle, or a name
 * that never bottoms out in a literal color, resolves to `undefined`
 * (absent) instead of hanging.
 */
function resolvePaletteChain(colors: JsonObject, name: string): string | undefined {
  const seen = new Set<string>();
  let current = name;

  for (let hop = 0; hop < MAX_PALETTE_HOPS; hop += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);

    const value = colors[current];
    if (typeof value !== 'string') return undefined;
    if (value.startsWith('#')) return value;

    current = value;
  }

  return undefined;
}

/** A `ui` value is either a literal color already, or a name to resolve through `colors`. */
function resolveNamedColor(value: string, colors: JsonObject): string | undefined {
  return value.startsWith('#') ? value : resolvePaletteChain(colors, value);
}

function resolveSlotColor(
  paths: readonly (readonly string[])[],
  ui: JsonObject,
  colors: JsonObject,
  canvasRgba: RgbaColor | undefined,
): string | undefined {
  for (const path of paths) {
    const raw = lookupPath(ui, path);
    if (typeof raw !== 'string') continue;

    const namedColor = resolveNamedColor(raw, colors);
    if (namedColor === undefined) continue;

    const hex = resolveOpaqueHex(namedColor, canvasRgba);
    if (hex !== undefined) return hex;
  }
  return undefined;
}

// First-hit-wins candidate path lists per slot, from the approved mapping.
const SLOT_PATHS: Readonly<Record<ThemeTokenName, readonly (readonly string[])[]>> = {
  canvas: [
    ['*', 'background'],
    ['Panel', 'background'],
  ],
  text: [
    ['*', 'foreground'],
    ['Label', 'foreground'],
  ],
  surface1: [
    ['EditorTabs', 'background'],
    ['ToolWindow', 'Header', 'background'],
  ],
  surface2: [
    ['Popup', 'background'],
    ['List', 'background'],
  ],
  surface3: [['ActionButton', 'hoverBackground']],
  border: [
    ['Component', 'borderColor'],
    ['Borders', 'color'],
  ],
  textMuted: [
    ['Label', 'infoForeground'],
    ['Component', 'infoForeground'],
  ],
  selection: [
    ['List', 'selectionBackground'],
    ['EditorPane', 'selectionBackground'],
  ],
  focus: [['Component', 'focusColor']],
  accent: [
    ['Component', 'focusColor'],
    ['Button', 'default', 'focusedBorderColor'],
    ['List', 'selectionBackground'],
  ],
  link: [
    ['Link', 'activeForeground'],
    ['Hyperlink', 'linkColor'],
  ],
  success: [['Label', 'successForeground']],
  warning: [['Label', 'warningForeground']],
  danger: [['Label', 'errorForeground']],
};

function resolveMode(dark: JsonValue | undefined): 'dark' | 'light' | undefined {
  if (typeof dark !== 'boolean') return undefined;
  return dark ? 'dark' : 'light';
}

export function parseJetbrainsUiTheme(content: string): ThemeSlots | ImportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(content));
  } catch (cause) {
    return parseError(`invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!isJsonObject(parsed)) return parseError('theme root is not a JSON object');

  const { name, ui, colors: colorsRaw } = parsed;
  if (typeof name !== 'string' || name.length === 0) return parseError('theme is missing a name');
  if (!isJsonObject(ui)) return parseError('theme is missing a "ui" object');

  const colors = isJsonObject(colorsRaw) ? colorsRaw : {};

  const canvasHex = resolveSlotColor(SLOT_PATHS.canvas, ui, colors, undefined);
  const canvasRgba = canvasHex !== undefined ? (parseCssColor(canvasHex) ?? undefined) : undefined;

  const tokens: Partial<ThemeTokens> = {};
  if (canvasHex !== undefined) tokens.canvas = canvasHex;
  for (const tokenName of THEME_TOKEN_NAMES) {
    if (tokenName === 'canvas') continue;
    const hex = resolveSlotColor(SLOT_PATHS[tokenName], ui, colors, canvasRgba);
    if (hex !== undefined) tokens[tokenName] = hex;
  }

  const mode = resolveMode(parsed.dark);

  return {
    name,
    sourceFormat: 'jetbrains-ui',
    tokens,
    ...(mode !== undefined ? { mode } : {}),
  };
}
