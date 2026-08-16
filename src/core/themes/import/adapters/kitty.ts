// kitty terminal config (kitty.conf) adapter. kitty's config is a flat list
// of `key value` lines (whitespace-separated, no `=`) covering everything
// from colors to fonts to keybindings; this adapter reads it line by line
// and only ever looks at the handful of color keys, skipping every other
// setting silently. Colors are always written as `#rrggbb` in real configs;
// unknown/non-color lines (including multi-value settings like
// `window_padding_width`) are skipped. This adapter only maps, it never
// derives.

import type { ThemeTokens } from '../../themeTypes';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseError } from '../resolveColor';

const DEFAULT_NAME = 'kitty theme';
const ANSI_COLOR_COUNT = 16;

const LEADING_TOKEN_PATTERN = /^(\S+)/;
const HEX_VALUE_PATTERN = /^#?([0-9a-fA-F]{6})$/;
const COLOR_KEY_PATTERN = /^color(\d{1,2})$/;

type Collected = {
  background: string | undefined;
  foreground: string | undefined;
  selection: string | undefined;
  link: string | undefined;
  ansi: (string | undefined)[];
};

function normalizeHex(rawValue: string): string | undefined {
  const match = HEX_VALUE_PATTERN.exec(rawValue.trim());
  return match?.[1] !== undefined ? `#${match[1].toLowerCase()}` : undefined;
}

/** A kitty.conf line is `key<whitespace>rest-of-line`; multi-value settings keep their extra tokens in `value` untouched (and simply fail to normalize as hex). */
function splitKeyValue(line: string): { key: string; value: string } | undefined {
  const key = LEADING_TOKEN_PATTERN.exec(line)?.[1];
  if (key === undefined) return undefined;
  const value = line.slice(key.length).trim();
  return value.length > 0 ? { key, value } : undefined;
}

function ansiIndexFor(key: string): number | undefined {
  const captured = COLOR_KEY_PATTERN.exec(key)?.[1];
  if (captured === undefined) return undefined;
  const index = Number.parseInt(captured, 10);
  return index >= 0 && index < ANSI_COLOR_COUNT ? index : undefined;
}

function applyLine(collected: Collected, pair: { key: string; value: string }): void {
  const ansiIndex = ansiIndexFor(pair.key);
  if (ansiIndex !== undefined) {
    const hex = normalizeHex(pair.value);
    if (hex !== undefined) collected.ansi[ansiIndex] = hex;
    return;
  }

  switch (pair.key) {
    case 'background':
      collected.background = normalizeHex(pair.value) ?? collected.background;
      return;
    case 'foreground':
      collected.foreground = normalizeHex(pair.value) ?? collected.foreground;
      return;
    case 'selection_background':
      collected.selection = normalizeHex(pair.value) ?? collected.selection;
      return;
    case 'url_color':
      collected.link = normalizeHex(pair.value) ?? collected.link;
      return;
    default:
      return;
  }
}

export function parseKittyTheme(content: string): ThemeSlots | ImportError {
  const collected: Collected = {
    background: undefined,
    foreground: undefined,
    selection: undefined,
    link: undefined,
    ansi: Array.from({ length: ANSI_COLOR_COUNT }, () => undefined),
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const pair = splitKeyValue(line);
    if (pair === undefined) continue;
    applyLine(collected, pair);
  }

  const { background, foreground, selection, link, ansi } = collected;
  const hasAnsi = ansi.some((hex) => hex !== undefined);
  const hasAny =
    background !== undefined ||
    foreground !== undefined ||
    selection !== undefined ||
    link !== undefined ||
    hasAnsi;
  if (!hasAny) return parseError('no color entries found');

  const tokens: Partial<ThemeTokens> = {};
  if (selection !== undefined) tokens.selection = selection;
  if (link !== undefined) tokens.link = link;

  return {
    name: DEFAULT_NAME,
    sourceFormat: 'kitty',
    tokens,
    ...(background !== undefined ? { background } : {}),
    ...(foreground !== undefined ? { foreground } : {}),
    ...(hasAnsi ? { ansi } : {}),
  };
}
