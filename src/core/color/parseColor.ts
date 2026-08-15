export type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

// A lowercase `#rrggbb` string, branded so a plain string (a raw CSS literal,
// an authored value, ...) can never stand in for one without going through
// `toHex`. The engine's color maps are keyed and valued by this type — see
// `ColorMapping` in colorMap.ts.
export type HexColor = string & { readonly __hexColor: unique symbol };

export function parseCssColor(value: string): RgbaColor | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  if (normalized.startsWith('#')) {
    return parseHexColor(normalized);
  }

  if (normalized.startsWith('rgb')) {
    return parseRgbColor(normalized);
  }

  if (normalized.startsWith('hsl')) {
    return parseHslColor(normalized);
  }

  return null;
}

export function parseHexColor(value: string): RgbaColor | null {
  const hex = value.replace('#', '').trim();

  if (![3, 4, 6, 8].includes(hex.length)) return null;

  const expanded = hex.length <= 4 ? Array.from(hex, (char) => char + char).join('') : hex;
  const hasAlpha = expanded.length === 8;
  const intValue = Number.parseInt(expanded, 16);

  if (Number.isNaN(intValue)) return null;

  return {
    r: (intValue >> (hasAlpha ? 24 : 16)) & 255,
    g: (intValue >> (hasAlpha ? 16 : 8)) & 255,
    b: (intValue >> (hasAlpha ? 8 : 0)) & 255,
    a: hasAlpha ? (intValue & 255) / 255 : 1,
  };
}

export function parseRgbColor(value: string): RgbaColor | null {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match?.[1]) return null;

  const parts = match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) return null;

  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);

  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b, a].some((part) => Number.isNaN(part))) return null;

  return {
    r: clampChannel(r),
    g: clampChannel(g),
    b: clampChannel(b),
    a: Math.max(0, Math.min(1, a)),
  };
}

export function parseHslColor(value: string): RgbaColor | null {
  const match = /hsla?\(([^)]+)\)/.exec(value);
  if (!match?.[1]) return null;

  const body = match[1].replace('/', ' ');
  const parts = body
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  const h = parseHue(parts[0] ?? '');
  const s = parsePercent(parts[1]);
  const l = parsePercent(parts[2]);
  const a = parseAlpha(parts[3]);

  if (h === null || s === null || l === null) return null;
  if ([h, s, l, a].some((part) => Number.isNaN(part))) return null;

  const { r, g, b } = hslToRgb(h, s, l);
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw?.endsWith('%')) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? null : parsed / 100;
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = Number.parseFloat(raw);
  return raw.endsWith('%') ? parsed / 100 : parsed;
}

const HUE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

function parseHue(raw: string): number | null {
  const match = /^(-?(?:\d+\.\d+|\.\d+|\d+))(deg|grad|rad|turn)?$/i.exec(raw);
  if (!match) return null;

  const [, numberPart, unit] = match;
  const value = Number.parseFloat(numberPart ?? '');
  if (Number.isNaN(value)) return null;
  if (!unit) return value;

  const multiplier = HUE_UNIT_MULTIPLIERS[unit.toLowerCase()];
  return multiplier === undefined ? null : value * multiplier;
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r1, g1, b1] = getHslRgbComponents(h, chroma, x);
  return {
    r: clampChannel((r1 + m) * 255),
    g: clampChannel((g1 + m) * 255),
    b: clampChannel((b1 + m) * 255),
  };
}

function getHslRgbComponents(h: number, chroma: number, x: number): [number, number, number] {
  if (h < 60) {
    return [chroma, x, 0];
  }
  if (h < 120) {
    return [x, chroma, 0];
  }
  if (h < 180) {
    return [0, chroma, x];
  }
  if (h < 240) {
    return [0, x, chroma];
  }
  if (h < 300) {
    return [x, 0, chroma];
  }
  return [chroma, 0, x];
}

export function toHex({ r, g, b }: RgbaColor): HexColor {
  const hex = `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
  return hex as HexColor;
}

// Shared opacity predicate: `toHex` drops alpha, so anywhere a color is
// reduced to its hex before entering the palette or matching a mapping entry
// must gate on this first — a translucent declaration (e.g. a modal scrim at
// rgba(0,0,0,0.5)) must never be treated as if it were the fully-opaque
// occurrence of the same RGB.
export function isOpaque(color: RgbaColor): boolean {
  return color.a === 1;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
