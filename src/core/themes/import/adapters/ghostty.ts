// Ghostty terminal theme (`.conf`) adapter. Ghostty's config format is a
// flat list of `key = value` lines; this adapter reads it line by line and
// only ever looks at the handful of color keys, skipping every other
// setting silently. Real Ghostty theme files write background/foreground/
// selection-background as BARE hex (no leading '#') but `palette = N=#hex`
// entries WITH a leading '#' -- both forms are normalized the same way here.
// This adapter only maps, it never derives.

import type { ImportError, ThemeSlots } from '../importTypes';
import { parseError } from '../resolveColor';

const DEFAULT_NAME = 'Ghostty theme';
const ANSI_COLOR_COUNT = 16;

const HEX_VALUE_PATTERN = /^#?([0-9a-fA-F]{6})$/;

type Collected = {
  background: string | undefined;
  foreground: string | undefined;
  selection: string | undefined;
  ansi: (string | undefined)[];
};

function normalizeHex(rawValue: string): string | undefined {
  const match = HEX_VALUE_PATTERN.exec(rawValue.trim());
  return match?.[1] !== undefined ? `#${match[1].toLowerCase()}` : undefined;
}

function splitOnFirst(
  line: string,
  separator: string,
): { left: string; right: string } | undefined {
  const separatorIndex = line.indexOf(separator);
  if (separatorIndex === -1) return undefined;
  return {
    left: line.slice(0, separatorIndex).trim(),
    right: line.slice(separatorIndex + 1).trim(),
  };
}

/** `palette = N=#hex` -- the value itself is a second `key=value` pair. */
function applyPaletteEntry(collected: Collected, value: string): void {
  const entry = splitOnFirst(value, '=');
  if (entry === undefined) return;
  const index = Number.parseInt(entry.left, 10);
  if (!(index >= 0 && index < ANSI_COLOR_COUNT)) return;
  const hex = normalizeHex(entry.right);
  if (hex !== undefined) collected.ansi[index] = hex;
}

function applyLine(collected: Collected, pair: { left: string; right: string }): void {
  switch (pair.left) {
    case 'background':
      collected.background = normalizeHex(pair.right) ?? collected.background;
      return;
    case 'foreground':
      collected.foreground = normalizeHex(pair.right) ?? collected.foreground;
      return;
    case 'selection-background':
      collected.selection = normalizeHex(pair.right) ?? collected.selection;
      return;
    case 'palette':
      applyPaletteEntry(collected, pair.right);
      return;
    default:
      return;
  }
}

export function parseGhosttyTheme(content: string): ThemeSlots | ImportError {
  const collected: Collected = {
    background: undefined,
    foreground: undefined,
    selection: undefined,
    ansi: Array.from({ length: ANSI_COLOR_COUNT }, () => undefined),
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const pair = splitOnFirst(line, '=');
    if (pair === undefined) continue;
    applyLine(collected, pair);
  }

  const { background, foreground, selection, ansi } = collected;
  const hasAnsi = ansi.some((hex) => hex !== undefined);
  if (background === undefined && foreground === undefined && selection === undefined && !hasAnsi) {
    return parseError('no color entries found');
  }

  return {
    name: DEFAULT_NAME,
    sourceFormat: 'ghostty',
    tokens: selection !== undefined ? { selection } : {},
    ...(background !== undefined ? { background } : {}),
    ...(foreground !== undefined ? { foreground } : {}),
    ...(hasAnsi ? { ansi } : {}),
  };
}
