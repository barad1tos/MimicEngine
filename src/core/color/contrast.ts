import { parseCssColor, type RgbaColor } from './parseColor';

export function relativeLuminance(color: RgbaColor): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);

  if (!fg || !bg || fg.a === 0 || bg.a === 0) return null;

  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);

  return (lighter + 0.05) / (darker + 0.05);
}

export function passesContrast(foreground: string, background: string, minimumRatio = 4.5): boolean {
  const ratio = contrastRatio(foreground, background);
  return ratio !== null && ratio >= minimumRatio;
}
