// iTerm2 color preset (.itermcolors) adapter. The root plist <dict> is a
// flat sequence of <key>NAME</key><dict>...</dict> pairs; each color's own
// dict holds Red/Green/Blue/Alpha Component <real> floats in 0-1. Background
// Color and Foreground Color map to the top-level ThemeSlots background/
// foreground fields (itermcolors has no editor-surface concept, so these
// don't go through `tokens`); Ansi N Color fills the indexed ansi array;
// Selection Color and Link Color map to tokens.selection/tokens.link. Each
// color's components are formatted as an rgba() CSS literal and routed
// through the shared resolveOpaqueHex so the same alpha-compositing policy
// (opaque -> hex, transparent -> absent, translucent -> composite over a
// known canvas or stay absent) applies uniformly, using the exact
// round(channel * 255) math the brief specifies without duplicating it here.
// This adapter only maps, it never derives.

import { parseCssColor, type RgbaColor } from '../../../color/parseColor';
import type { ThemeTokens } from '../../themeTypes';
import {
  ITERM_THEME_NAME as DEFAULT_NAME,
  type ImportError,
  type ThemeSlots,
} from '../importTypes';
import { parseError, resolveOpaqueHex } from '../resolveColor';

const ANSI_COLOR_COUNT = 16;

/** Finds the element following a `<key>keyName</key>` sibling in a plist dict's direct children. */
function findEntry(dict: Element, keyName: string): Element | undefined {
  const children = Array.from(dict.children);
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node?.nodeName === 'key' && node.textContent === keyName) {
      return children[index + 1];
    }
  }
  return undefined;
}

function realComponent(colorDict: Element, keyName: string): number | undefined {
  const entry = findEntry(colorDict, keyName);
  if (entry?.nodeName !== 'real') return undefined;
  const parsed = Number.parseFloat(entry.textContent);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toRgbaLiteral(colorDict: Element): string | undefined {
  const red = realComponent(colorDict, 'Red Component');
  const green = realComponent(colorDict, 'Green Component');
  const blue = realComponent(colorDict, 'Blue Component');
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  const alpha = realComponent(colorDict, 'Alpha Component') ?? 1;
  return `rgba(${String(red * 255)}, ${String(green * 255)}, ${String(blue * 255)}, ${String(alpha)})`;
}

function resolveColorHex(
  root: Element,
  keyName: string,
  canvasRgba: RgbaColor | undefined,
): string | undefined {
  const colorDict = findEntry(root, keyName);
  if (colorDict?.nodeName !== 'dict') return undefined;
  const raw = toRgbaLiteral(colorDict);
  return raw !== undefined ? resolveOpaqueHex(raw, canvasRgba) : undefined;
}

function resolveAnsi(
  root: Element,
  canvasRgba: RgbaColor | undefined,
): (string | undefined)[] | undefined {
  const ansi = Array.from({ length: ANSI_COLOR_COUNT }, (_, index) =>
    resolveColorHex(root, `Ansi ${String(index)} Color`, canvasRgba),
  );
  return ansi.some((hex) => hex !== undefined) ? ansi : undefined;
}

export function parseItermColors(content: string): ThemeSlots | ImportError {
  const doc = new DOMParser().parseFromString(content, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return parseError('malformed XML');
  }

  const root = doc.querySelector('plist > dict');
  if (root === null) return parseError('missing plist root dict');

  const backgroundHex = resolveColorHex(root, 'Background Color', undefined);
  const canvasRgba =
    backgroundHex !== undefined ? (parseCssColor(backgroundHex) ?? undefined) : undefined;

  const foregroundHex = resolveColorHex(root, 'Foreground Color', canvasRgba);
  const selectionHex = resolveColorHex(root, 'Selection Color', canvasRgba);
  const linkHex = resolveColorHex(root, 'Link Color', canvasRgba);
  const ansi = resolveAnsi(root, canvasRgba);

  const tokens: Partial<ThemeTokens> = {};
  if (selectionHex !== undefined) tokens.selection = selectionHex;
  if (linkHex !== undefined) tokens.link = linkHex;

  return {
    name: DEFAULT_NAME,
    sourceFormat: 'iterm',
    tokens,
    ...(backgroundHex !== undefined ? { background: backgroundHex } : {}),
    ...(foregroundHex !== undefined ? { foreground: foregroundHex } : {}),
    ...(ansi !== undefined ? { ansi } : {}),
  };
}
