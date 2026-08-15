export type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

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

export function toHex({ r, g, b }: RgbaColor): string {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
