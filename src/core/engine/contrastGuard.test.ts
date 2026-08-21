// src/core/engine/contrastGuard.test.ts
import { describe, expect, it, vi } from 'vitest';
import { contrastRatio } from '../color/contrast';
import { oklchToRgba, rgbaToOklch } from '../color/oklch';
import { parseCssColor, toHex, type HexColor, type RgbaColor } from '../color/parseColor';
import { builtInThemes, type PaletteTheme } from '../themes';
import { buildColorMapping, type ColorMapping, type SitePaletteEntry } from './colorMap';
import { guardContrast, repairTextTarget, type GuardedMapping } from './contrastGuard';

const catppuccinFrappe = builtInThemes[0];

function requireColor(hex: string): RgbaColor {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad test hex ${hex}`);
  return color;
}

// Converts a plain CSS color literal to the branded HexColor type ColorMapping
// and SitePaletteEntry now require — the same toHex(parseCssColor(...)) path
// production code uses, just wrapped for test-fixture literals.
function hex(value: string): HexColor {
  return toHex(requireColor(value));
}

function entry(hexValue: string, bucket: SitePaletteEntry['bucket'], weight = 1): SitePaletteEntry {
  return { hex: hex(hexValue), color: requireColor(hexValue), weight, bucket };
}

// Every "one background entry, one text entry" test shares this exact shape:
// only the two hex values under test differ.
function buildSingleTextFixture(
  backgroundHex: string,
  textTargetHex: string,
): { palette: SitePaletteEntry[]; mapping: ColorMapping } {
  return {
    palette: [entry('#111111', 'background', 10), entry('#222222', 'text', 5)],
    mapping: new Map([
      [hex('#111111'), hex(backgroundHex)],
      [hex('#222222'), hex(textTargetHex)],
    ]),
  };
}

function guardSingleTextFixture(
  backgroundHex: string,
  textTargetHex: string,
  theme: PaletteTheme = catppuccinFrappe,
): GuardedMapping {
  const { palette, mapping } = buildSingleTextFixture(backgroundHex, textTargetHex);
  return guardContrast(mapping, palette, theme);
}

function expectFailingPair(foreground: string, background: string): void {
  expect(contrastRatio(foreground, background)).not.toBeNull();
  expect(contrastRatio(foreground, background)).toBeLessThan(4.5);
}

describe('guardContrast', () => {
  it('falls back to the theme text token when pure-lightness stepping cannot reach 4.5', () => {
    // Chroma/hue preserved from canvas itself, l pinned right next to
    // canvas's own l: hand-traced across all 8 steps (down to l=0, pure
    // black) the ratio only climbs 1.03 -> 1.71, nowhere near 4.5 -- against
    // this background, no amount of pure-lightness movement on this hue can
    // pass, so the fallback is the only correct outcome, not a coincidence
    // of a badly-chosen step budget.
    const canvas = catppuccinFrappe.tokens.canvas;
    const failingTarget = toHex(oklchToRgba({ ...rgbaToOklch(requireColor(canvas)), l: 0.32 }));
    expectFailingPair(failingTarget, canvas);

    const { mapping: repaired, adjustments } = guardSingleTextFixture(canvas, failingTarget);

    expect(adjustments).toBe(1);
    expect(repaired.get(hex('#222222'))).toBe(catppuccinFrappe.tokens.text);
  });

  it('performs a genuine stepped repair when the background leaves enough headroom', () => {
    // Neutral gray background (l≈0.949) vs a mid-gray text target (l=0.6,
    // ratio 3.40, failing). Hand-traced: step 1 (l=0.55) reaches 4.21, still
    // short; step 2 (l=0.50) reaches 5.18 and is the first pass -- landing
    // at step 2 of the max 8, well before any fallback would trigger.
    const backgroundHex = '#eeeeee';
    const failingTarget = '#808080';
    expectFailingPair(failingTarget, backgroundHex);

    const { mapping: repaired, adjustments } = guardSingleTextFixture(backgroundHex, failingTarget);

    const repairedTarget = repaired.get(hex('#222222'));
    expect(adjustments).toBe(1);
    expect(repairedTarget).toBe('#636363');
    expect(repairedTarget).not.toBe(failingTarget);
    expect(repairedTarget).not.toBe(catppuccinFrappe.tokens.text);
    expect(contrastRatio(repairedTarget ?? '', backgroundHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('performs a genuine stepped repair in the +1 (increase) direction against a dark background', () => {
    // Near-black background (l=0.03) vs a dark-gray text target (l=0.35,
    // ratio 1.85, failing) that is already lighter than the background, so
    // target.l >= backgroundL selects the "increase" branch. Hand-traced:
    // steps 1-4 (l=0.40..0.55) stay below 4.5; step 5 (l=0.60) reaches
    // ~5.32 and is the first pass -- landing well before the step budget
    // runs out, so this is a genuine stepped repair, not the fallback.
    const backgroundHex = toHex(oklchToRgba({ l: 0.03, c: 0, h: 0 }));
    const failingTarget = toHex(oklchToRgba({ l: 0.35, c: 0, h: 0 }));
    expectFailingPair(failingTarget, backgroundHex);

    const { mapping: repaired, adjustments } = guardSingleTextFixture(backgroundHex, failingTarget);

    const repairedTarget = repaired.get(hex('#222222'));
    expect(adjustments).toBe(1);
    expect(repairedTarget).toBe('#808080');
    expect(repairedTarget).not.toBe(catppuccinFrappe.tokens.text);
    expect(contrastRatio(repairedTarget ?? '', backgroundHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('steps lightness away from a light background (target already darker gets darker still)', () => {
    // A light (high-l) background with a text target that starts slightly
    // darker but still too close: target.l < background.l selects the
    // "decrease" branch, so the repair must land strictly darker.
    const backgroundHex = toHex(oklchToRgba({ l: 0.85, c: 0, h: 0 }));
    const failingTarget = toHex(oklchToRgba({ l: 0.75, c: 0, h: 0 }));
    expectFailingPair(failingTarget, backgroundHex);

    const { mapping: repaired } = guardSingleTextFixture(backgroundHex, failingTarget);

    const repairedTarget = repaired.get(hex('#222222'));
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
      [hex('#111111'), hex(canvas)],
      [hex('#222222'), hex(passingTarget)],
      [hex('#333333'), hex(catppuccinFrappe.tokens.border)],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(0);
    expect(JSON.stringify([...repaired])).toBe(JSON.stringify([...mapping]));
  });

  it('leaves non-text and unmapped entries untouched', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const borderTarget = catppuccinFrappe.tokens.border;

    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#333333', 'border', 3),
    ];
    const mapping: ColorMapping = new Map([
      [hex('#111111'), hex(canvas)],
      [hex('#333333'), hex(borderTarget)],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(0);
    expect(repaired.get(hex('#333333'))).toBe(borderTarget);
  });

  it('repairs a brand-preserved text entry that fails contrast, stepping lightness only (hue preserved, finding 5)', () => {
    // Own chroma ~0.172 (past BRAND_CHROMA_THRESHOLD), own hue
    // ~142.5 — colorMap.ts's mapAccent excludes it from the accent map
    // entirely when preserveBrandColors is set, so `mapping` never contains
    // it; guardContrast must pick it up straight from `palette`.
    const canvas = catppuccinFrappe.tokens.canvas;
    const brandTextHex = '#007b00';
    expectFailingPair(brandTextHex, canvas);
    const palette: SitePaletteEntry[] = [entry(brandTextHex, 'text', 1)];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: true });
    expect(mapping.has(hex(brandTextHex))).toBe(false);

    const { mapping: guarded, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(1);
    const repairedHex = guarded.get(hex(brandTextHex));
    expect(repairedHex).toBeDefined();
    expect(contrastRatio(repairedHex ?? '', canvas)).toBeGreaterThanOrEqual(4.5);

    const originalHue = rgbaToOklch(requireColor(brandTextHex)).h;
    const repairedHue = rgbaToOklch(requireColor(repairedHex ?? '')).h;
    expect(Math.abs(repairedHue - originalHue)).toBeLessThanOrEqual(2);
  });

  it('leaves a brand-preserved text entry unmapped (true preservation) when it already passes contrast (finding 5)', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const passingBrandTextHex = '#4dba30'; // own chroma ~0.1995, already passes vs canvas
    expect(contrastRatio(passingBrandTextHex, canvas)).toBeGreaterThanOrEqual(4.5);
    const palette: SitePaletteEntry[] = [entry(passingBrandTextHex, 'text', 1)];

    const mapping = buildColorMapping(palette, catppuccinFrappe, { preserveBrandColors: true });
    expect(mapping.has(hex(passingBrandTextHex))).toBe(false);

    const { mapping: guarded, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(0);
    expect(guarded.has(hex(passingBrandTextHex))).toBe(false);
  });

  it('warns and falls back to the theme text token when the mapped target is unparseable', () => {
    // HexColor is a type-level guarantee (branded, produced by toHex), not a
    // runtime one — this hand-builds a mapping entry that bypasses toHex to
    // exercise the defensive path a corrupted/unexpected value would hit.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const canvas = catppuccinFrappe.tokens.canvas;
    const palette: SitePaletteEntry[] = [
      entry('#111111', 'background', 10),
      entry('#222222', 'text', 5),
    ];
    const mapping: ColorMapping = new Map([
      [hex('#111111'), hex(canvas)],
      [hex('#222222'), 'not-a-color' as HexColor],
    ]);

    const { mapping: repaired, adjustments } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(adjustments).toBe(1);
    expect(repaired.get(hex('#222222'))).toBe(catppuccinFrappe.tokens.text);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Palette Mimicry] unparseable color in contrast repair',
      expect.objectContaining({ targetHex: 'not-a-color' }),
    );
  });

  it('exports repairTextTarget for direct reuse against an arbitrary paired background (C-2)', () => {
    // computedFallback's per-selector paired guard reuses this exact
    // stepping algorithm rather than duplicating it (see
    // computedFallback.test.ts's own C-2 regression, which exercises this
    // through the full produce() pipeline) -- this pins the export itself
    // and its 3-arg contract directly.
    const backgroundHex = '#969696';
    const failingTarget = catppuccinFrappe.tokens.canvas;
    expectFailingPair(failingTarget, backgroundHex);

    const repaired = repairTextTarget(hex(failingTarget), hex(backgroundHex), hex(failingTarget));

    expect(contrastRatio(repaired, backgroundHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('does not mutate the input mapping', () => {
    const canvas = catppuccinFrappe.tokens.canvas;
    const failingTarget = toHex(oklchToRgba({ ...rgbaToOklch(requireColor(canvas)), l: 0.32 }));
    const { palette, mapping } = buildSingleTextFixture(canvas, failingTarget);
    const snapshotBefore = JSON.stringify([...mapping]);

    const { mapping: repaired } = guardContrast(mapping, palette, catppuccinFrappe);

    expect(JSON.stringify([...mapping])).toBe(snapshotBefore);
    expect(repaired).not.toBe(mapping);
  });
});
