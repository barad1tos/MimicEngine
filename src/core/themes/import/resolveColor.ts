// Shared opaque-color resolution for theme-import adapters. Turns a raw CSS
// color literal into an opaque hex slot value: fully transparent yields
// nothing (absent, not a slot value), and a partial-alpha value (JetBrains
// and VS Code source formats both use them) composites over an
// already-resolved canvas when one is known. This "unusable value" policy is
// import-specific — adapters treat missing evidence as absence for later
// derivation — so it lives here rather than in the general-purpose
// src/core/color module. Also carries the minimal loose-JSON helpers every
// JSON-based adapter needs (parse error shaping, object narrowing).

import { parseCssColor, toHex, type RgbaColor } from '../../color/parseColor';
import type { ImportError } from './importTypes';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function parseError(message: string): ImportError {
  return { stage: 'parse', message };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Standard "over" alpha compositing of a translucent foreground onto an opaque canvas. */
export function compositeOverCanvas(foreground: RgbaColor, canvas: RgbaColor): RgbaColor {
  return {
    r: foreground.r * foreground.a + canvas.r * (1 - foreground.a),
    g: foreground.g * foreground.a + canvas.g * (1 - foreground.a),
    b: foreground.b * foreground.a + canvas.b * (1 - foreground.a),
    a: 1,
  };
}

/**
 * Turns a raw color literal into an opaque hex slot value. Fully transparent
 * yields nothing (absent, per the composite semantics adapters follow). A
 * partial-alpha value composites over `canvasRgba` when one is already
 * known; without a canvas to composite against, it's also absent rather than
 * guessed.
 */
export function resolveOpaqueHex(
  rawColor: string,
  canvasRgba: RgbaColor | undefined,
): string | undefined {
  const rgba = parseCssColor(rawColor);
  if (!rgba || rgba.a === 0) return undefined;
  if (rgba.a === 1) return toHex(rgba);
  if (!canvasRgba) return undefined;
  return toHex(compositeOverCanvas(rgba, canvasRgba));
}
