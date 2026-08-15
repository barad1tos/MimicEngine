import { parseCssColor, type RgbaColor } from './parseColor';

export function relativeLuminance(color: RgbaColor): number {
  const linearize = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);

  // A translucent background composites with an unknown backdrop, so no ratio can be computed.
  if (!fg || !bg || fg.a === 0 || bg.a < 1) return null;

  const fgLum = relativeLuminance(compositeOver(fg, bg));
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);

  return (lighter + 0.05) / (darker + 0.05);
}

function compositeOver(foreground: RgbaColor, backdrop: RgbaColor): RgbaColor {
  if (foreground.a === 1) return foreground;

  const alpha = foreground.a;
  return {
    r: foreground.r * alpha + backdrop.r * (1 - alpha),
    g: foreground.g * alpha + backdrop.g * (1 - alpha),
    b: foreground.b * alpha + backdrop.b * (1 - alpha),
    a: 1,
  };
}

export function passesContrast(
  foreground: string,
  background: string,
  minimumRatio = 4.5,
): boolean {
  const ratio = contrastRatio(foreground, background);
  return ratio !== null && ratio >= minimumRatio;
}
