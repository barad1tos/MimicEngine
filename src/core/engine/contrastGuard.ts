import { passesContrast } from '../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../color/oklch';
import { parseCssColor, toHex } from '../color/parseColor';
import type { PaletteTheme } from '../themes';
import type { ColorMapping, SitePaletteEntry } from './colorMap';

export type GuardedMapping = { mapping: ColorMapping; adjustments: number };

const LIGHTNESS_STEP = 0.05;
const MAX_LIGHTNESS_STEPS = 8;

function compareHexAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

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
      return compareHexAscending(candidate.hex, best.hex) < 0 ? candidate : best;
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
): string {
  const heaviest = heaviestBackgroundEntry(palette);
  const mapped = heaviest ? mapping.get(heaviest.hex) : undefined;
  return mapped ?? theme.tokens.canvas;
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
function repairTextTarget(targetHex: string, backgroundHex: string, themeTextHex: string): string {
  if (passesContrast(targetHex, backgroundHex)) return targetHex;

  const targetColor = parseCssColor(targetHex);
  const backgroundColor = parseCssColor(backgroundHex);
  if (!targetColor || !backgroundColor) return themeTextHex;

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
  const paletteByHex = new Map(palette.map((entry) => [entry.hex, entry]));
  const backgroundHex = resolveBackgroundHex(palette, mapping, theme);

  let adjustments = 0;
  const repaired: ColorMapping = new Map();

  for (const [hex, target] of mapping) {
    if (paletteByHex.get(hex)?.bucket !== 'text') {
      repaired.set(hex, target);
      continue;
    }

    const repairedHex = repairTextTarget(target, backgroundHex, theme.tokens.text);
    if (repairedHex !== target) adjustments += 1;
    repaired.set(hex, repairedHex);
  }

  return { mapping: repaired, adjustments };
}
