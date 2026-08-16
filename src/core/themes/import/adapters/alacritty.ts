// Alacritty terminal theme (TOML) adapter. Alacritty's config is TOML, but
// this adapter reads it as line-based `[section]` headers plus `key = value`
// pairs -- the only shapes a color-only theme file ever uses -- rather than
// pulling in a full TOML parser for a handful of hex literals. Colors are
// plain opaque hex, written either as a quoted `"#rrggbb"` string or a
// `0x`-prefixed literal (both forms ship in real presets); comments and
// unknown keys (e.g. `bright_foreground` under `[colors.primary]`, which
// Alacritty itself doesn't map to any theme slot) are skipped silently.
// This adapter only maps, it never derives.

import {
  ALACRITTY_THEME_NAME as DEFAULT_NAME,
  type ImportError,
  type ThemeSlots,
} from '../importTypes';
import { parseError } from '../resolveColor';

const ANSI_COLOR_COUNT = 16;

const SECTION_PATTERN = /^\[colors\.(primary|normal|bright|selection)]$/;
const HEX_VALUE_PATTERN = /^(?:#|0[xX])?([0-9a-fA-F]{6})$/;

// Alacritty names normal/bright colors by role rather than index; this is
// their fixed order onto ansi[0..7] (normal) / ansi[8..15] (bright).
const ANSI_KEY_ORDER: readonly string[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

function normalizeHex(rawValue: string): string | undefined {
  const compact = rawValue
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '');
  const match = HEX_VALUE_PATTERN.exec(compact);
  return match?.[1] !== undefined ? `#${match[1].toLowerCase()}` : undefined;
}

/**
 * Strips a TOML `#`-comment from a single line, quote-aware so a `#` inside
 * a quoted value (the hex colors this adapter cares about are always quoted)
 * survives untouched. A plain "remove from first #" regex would truncate
 * `background = "#1f2430" # base` at the color's own `#`, so this walks the
 * line char-by-char like jsonc.ts's stripComments instead of regex-hacking
 * it. No backslash-escape handling: TOML string literals can carry escaped
 * quotes, but the only values this adapter reads are bare hex colors, which
 * never do.
 */
function stripTomlComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      return line.slice(0, index);
    }
  }

  return line;
}

function splitKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf('=');
  if (separatorIndex === -1) return undefined;
  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  return key.length > 0 ? { key, value } : undefined;
}

type Section = 'primary' | 'normal' | 'bright' | 'selection';

type Collected = {
  background: string | undefined;
  foreground: string | undefined;
  selection: string | undefined;
  ansi: (string | undefined)[];
};

function matchSection(line: string): Section | undefined {
  const match = SECTION_PATTERN.exec(line);
  const captured = match?.[1];
  if (captured === 'primary' || captured === 'normal' || captured === 'bright') return captured;
  if (captured === 'selection') return 'selection';
  return undefined;
}

function applyAnsiKey(
  collected: Collected,
  section: 'normal' | 'bright',
  key: string,
  hex: string,
): void {
  const ansiIndex = ANSI_KEY_ORDER.indexOf(key);
  if (ansiIndex === -1) return;
  collected.ansi[section === 'normal' ? ansiIndex : ansiIndex + 8] = hex;
}

function applyLine(
  collected: Collected,
  section: Section,
  pair: { key: string; value: string },
): void {
  const hex = normalizeHex(pair.value);
  if (hex === undefined) return;

  if (section === 'primary') {
    if (pair.key === 'background') collected.background = hex;
    else if (pair.key === 'foreground') collected.foreground = hex;
    return;
  }
  if (section === 'selection') {
    if (pair.key === 'background') collected.selection = hex;
    return;
  }
  applyAnsiKey(collected, section, pair.key, hex);
}

export function parseAlacrittyTheme(content: string): ThemeSlots | ImportError {
  const collected: Collected = {
    background: undefined,
    foreground: undefined,
    selection: undefined,
    ansi: Array.from({ length: ANSI_COLOR_COUNT }, () => undefined),
  };
  let section: Section | undefined;

  for (const rawLine of content.split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;

    if (line.startsWith('[')) {
      section = matchSection(line);
      continue;
    }
    if (section === undefined) continue;

    const pair = splitKeyValue(line);
    if (pair === undefined) continue;
    applyLine(collected, section, pair);
  }

  const { background, foreground, selection, ansi } = collected;
  const hasAnsi = ansi.some((hex) => hex !== undefined);
  if (background === undefined && foreground === undefined && selection === undefined && !hasAnsi) {
    return parseError('no color entries found');
  }

  return {
    name: DEFAULT_NAME,
    sourceFormat: 'alacritty',
    tokens: selection !== undefined ? { selection } : {},
    ...(background !== undefined ? { background } : {}),
    ...(foreground !== undefined ? { foreground } : {}),
    ...(hasAnsi ? { ansi } : {}),
  };
}
