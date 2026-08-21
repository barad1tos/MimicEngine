import { passesContrast } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor } from '../color/parseColor';
import type { PaletteTheme } from '../themes';
import { mappingKeyOf, themeTokenHex, type ColorMapping, type SitePaletteEntry } from './colorMap';
import { compareStrings } from './sort';

export type GuardedMapping = { mapping: ColorMapping; adjustments: number };

const LIGHTNESS_STEP = 0.05;
const MAX_LIGHTNESS_STEPS = 8;

// Same weight-desc/hex-asc ordering colorMap.ts uses to pick the dominant
// entry within a bucket, scoped here to the background bucket only.
function heaviestBackgroundEntry(
  palette: readonly SitePaletteEntry[],
): SitePaletteEntry | undefined {
  return palette
    .filter((entry) => entry.bucket === 'background')
    .reduce<SitePaletteEntry | undefined>((best, candidate) => {
      if (!best) return candidate;
      if (candidate.weight !== best.weight)
        return candidate.weight > best.weight ? candidate : best;
      return compareStrings(candidate.hex, best.hex) < 0 ? candidate : best;
    }, undefined);
}

// Approximation fixed by the plan: text targets are checked against the
// mapped value of the heaviest background-bucket entry (the ladder's
// canvas rung in practice), falling back to the theme's own canvas token
// when no background entry made it into the mapping.
function resolveBackgroundHex(
  palette: readonly SitePaletteEntry[],
  mapping: ColorMapping,
  theme: PaletteTheme,
): HexColor {
  const heaviest = heaviestBackgroundEntry(palette);
  const mapped = heaviest ? mapping.get(mappingKeyOf(heaviest)) : undefined;
  return mapped ?? themeTokenHex(theme, 'canvas');
}

function clampLightness(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function stepAwayFromBackground(target: Oklch, backgroundL: number, step: number): Oklch {
  const direction = target.l >= backgroundL ? 1 : -1;
  const nextLightness = clampLightness(target.l + direction * LIGHTNESS_STEP * step);
  return { l: nextLightness, c: target.c, h: target.h };
}

// Failing text targets step OKLCH `l` away from the background's `l`, up to
// MAX_LIGHTNESS_STEPS, re-checking WCAG contrast via a hex round-trip after
// each step. The first passing hex wins; if none pass, the curated theme
// `text` token is the deterministic fallback.
function repairTextTarget(
  targetHex: HexColor,
  backgroundHex: HexColor,
  themeTextHex: HexColor,
): HexColor {
  if (passesContrast(targetHex, backgroundHex)) return targetHex;

  const targetColor = parseCssColor(targetHex);
  const backgroundColor = parseCssColor(backgroundHex);
  if (!targetColor || !backgroundColor) {
    // HexColor is a type-level guarantee, not a runtime one — a value that
    // reached here without actually going through toHex() (corrupted state,
    // a future caller bypassing the constructor) fails to parse silently
    // otherwise. Surface it before falling back to the theme's text token.
    console.warn('[Palette Mimicry] unparseable color in contrast repair', {
      targetHex,
      backgroundHex,
    });
    return themeTextHex;
  }

  const targetOklch = rgbaToOklch(targetColor);
  const backgroundL = rgbaToOklch(backgroundColor).l;

  for (let step = 1; step <= MAX_LIGHTNESS_STEPS; step += 1) {
    const candidateOklch = stepAwayFromBackground(targetOklch, backgroundL, step);
    const candidateHex = toHex(oklchToRgba(candidateOklch));
    if (passesContrast(candidateHex, backgroundHex)) return candidateHex;
  }

  return themeTextHex;
}

// Repairs every mapped text-bucket target that fails WCAG contrast against
// the mapped background, in OKLCH lightness steps away from the background;
// entries that already pass, and non-text or unmapped entries, are returned
// unchanged. Always returns a new Map with the input's iteration order
// preserved — the input mapping is never mutated.
export function guardContrast(
  mapping: ColorMapping,
  palette: SitePaletteEntry[],
  theme: PaletteTheme,
): GuardedMapping {
  const paletteByKey = new Map(palette.map((entry) => [mappingKeyOf(entry), entry]));
  const backgroundHex = resolveBackgroundHex(palette, mapping, theme);

  let adjustments = 0;
  const repaired: ColorMapping = new Map();
  const themeTextHex = themeTokenHex(theme, 'text');

  for (const [key, target] of mapping) {
    if (paletteByKey.get(key)?.bucket !== 'text') {
      repaired.set(key, target);
      continue;
    }

    const repairedHex = repairTextTarget(target, backgroundHex, themeTextHex);
    if (repairedHex !== target) adjustments += 1;
    repaired.set(key, repairedHex);
  }

  adjustments += repairBrandText(palette, mapping, backgroundHex, theme, repaired);

  return { mapping: repaired, adjustments };
}

// colorMap.ts's mapAccent exempts a text-bucket entry from the accent map
// (leaves it out of `mapping` entirely) whenever preserveBrandColors is set
// and its chroma exceeds the brand-preserve threshold — "preserve the brand
// color" for every other bucket, but for text that can't be the whole story:
// an unreadable brand color is a legibility bug, not a feature. This is the
// other half of that contract: every text-bucket palette entry absent from
// `mapping` (there is no other way a text entry ends up unmapped — see
// mapAccent's doc comment) is checked here against the resolved background.
// Already-passing entries are true preservation (left unmapped, original
// color used as-is). Failing entries get a genuine mapping entry via the
// same lightness-only repair path as any other text color, so hue and
// chroma — the brand identity — survive untouched.
function repairBrandText(
  palette: readonly SitePaletteEntry[],
  mapping: ColorMapping,
  backgroundHex: HexColor,
  theme: PaletteTheme,
  repaired: ColorMapping,
): number {
  let adjustments = 0;
  const themeTextHex = themeTokenHex(theme, 'text');

  for (const entry of palette) {
    if (entry.bucket !== 'text') continue;
    if (mapping.has(mappingKeyOf(entry))) continue;

    const repairedHex = repairTextTarget(entry.hex, backgroundHex, themeTextHex);
    if (repairedHex === entry.hex) continue;

    repaired.set(mappingKeyOf(entry), repairedHex);
    adjustments += 1;
  }

  return adjustments;
}
