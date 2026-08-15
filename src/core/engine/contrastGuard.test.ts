// src/core/engine/contrastGuard.test.ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch } from '../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../color/parseColor';
import { builtInThemes } from '../themes';
import type { ColorMapping, SitePaletteEntry } from './colorMap';
import { guardContrast } from './contrastGuard';

const catppuccinFrappe = builtInThemes[0];

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
}

function entry(hex: string, bucket: SitePaletteEntry['bucket'], weight = 1): SitePaletteEntry {
  return { hex, color: requireColor(hex), weight, bucket };
}

describe('guardContrast', () => {
  it('repairs a failing text target to pass contrast against the mapped background', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const failingTarget = toHex(oklchToRgba({ ...rgbaToOklch(requireColor(canvas)), l: 0.32 }));
    expect(contrastRatio(failingTarget, canvas)).not.toBeNull();
    expect(contrastRatio(failingTarget, canvas)).toBeLessThan(4.5);

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', canvas],
      ['#222222', failingTarget],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(1);
    const repairedTarget = repaired.get('#222222');
    expect(repairedTarget).toBeDefined();
    expect(repairedTarget).not.toBe(failingTarget);
    const ratio = contrastRatio(repairedTarget ?? '', canvas);
    expect(ratio).not.toBeNull();
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('steps lightness away from a light background (target already darker gets darker still)', () => {
    // A light (high-l) background with a text target that starts slightly
    // darker but still too close: target.l < background.l selects the
    // "decrease" branch, so the repair must land strictly darker.
    const backgroundHex = toHex(oklchToRgba({ l: 0.85, c: 0, h: 0 }));
    const failingTarget = toHex(oklchToRgba({ l: 0.75, c: 0, h: 0 }));
    expect(contrastRatio(failingTarget, backgroundHex)).not.toBeNull();
    expect(contrastRatio(failingTarget, backgroundHex)).toBeLessThan(4.5);

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', backgroundHex],
      ['#222222', failingTarget],
    ]);

    const { mapping: repaired } = guardContrast(mapping, palette, catppuccinFrappe);

    const repairedTarget = repaired.get('#222222');
    expect(repairedTarget).toBeDefined();
    const repairedL = rgbaToOklch(requireColor(repairedTarget ?? '')).l;
    expect(repairedL).toBeLessThan(0.75);
  });

  it('returns an already-passing mapping with identical entries and order, adjustments 0', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const passingTarget = catppuccinFrappe.tokens.text;
    expect(contrastRatio(passingTarget, canvas)).not.toBeNull();
    expect(contrastRatio(passingTarget, canvas)).toBeGreaterThanOrEqual(4.5);

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
      entry('#333333', 'border', 3),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', canvas],
      ['#222222', passingTarget],
      ['#333333', catppuccinFrappe.tokens.border],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(0);
    expect(JSON.stringify([...repaired])).toBe(JSON.stringify([...mapping]));
  });

  it('falls back to the theme text token when no step reaches 4.5', () => {
    // A near-mid-gray background where an equally near-mid-gray target has
    // nowhere to move within 8 steps of 0.05 (0.4 total) and still fail: the
    // background itself sits within that travel range in both directions,
    // so every step keeps colliding with (or landing too close to) it.
    const backgroundHex = toHex(oklchToRgba({ l: 0.5, c: 0, h: 0 }));
    const failingTarget = toHex(oklchToRgba({ l: 0.5, c: 0, h: 0 }));
    expect(contrastRatio(failingTarget, backgroundHex)).not.toBeNull();
    expect(contrastRatio(failingTarget, backgroundHex)).toBeLessThan(4.5);

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', backgroundHex],
      ['#222222', failingTarget],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(1);
    expect(repaired.get('#222222')).toBe(catppuccinFrappe.tokens.text);
  });

  it('leaves non-text and unmapped entries untouched', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const borderTarget = catppuccinFrappe.tokens.border;

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#333333', 'border', 3),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', canvas],
      ['#333333', borderTarget],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(0);
    expect(repaired.get('#333333')).toBe(borderTarget);
  });

  it('does not mutate the input mapping', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const failingTarget = toHex(oklchToRgba({ ...rgbaToOklch(requireColor(canvas)), l: 0.32 }));

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
    ];
    const mapping: ColorMapping = new Map([
      ['#111111', canvas],
      ['#222222', failingTarget],
    ]);
    const snapshotBefore = JSON.stringify([...mapping]);

    const { mapping: repaired } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(JSON.stringify([...mapping])).toBe(snapshotBefore);
    expect(repaired).not.toBe(mapping);
  });
});
