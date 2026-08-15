import type { RgbaColor } from './parseColor';

/**
 * A color in the OKLCH cylindrical color space.
 *
 * - `l` (lightness): 0 (black) to 1 (white).
 * - `c` (chroma): 0 (achromatic) upward, unbounded in principle but in
 *   practice bounded by what's representable in sRGB.
 * - `h` (hue): degrees, normalized to [0, 360). Meaningless at zero chroma —
 *   by convention `h` is 0 whenever `c` is (approximately) 0, rather than an
 *   arbitrary leftover angle.
 */
export type Oklch = { l: number; c: number; h: number };

type Vector3 = readonly [number, number, number];
type Matrix3 = readonly [Vector3, Vector3, Vector3];

const SRGB_DECODE_THRESHOLD = 0.04045;
const SRGB_ENCODE_THRESHOLD = 0.0031308;
const SRGB_GAMMA = 2.4;
const HUE_EPSILON = 1e-4;
const DEGREES_PER_TURN = 360;

// OKLab color space per Björn Ottosson, "A perceptual color space for image
// processing" (https://bottosson.github.io/posts/oklab/).
const LINEAR_RGB_TO_LMS: Matrix3 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];

const LMS_TO_OKLAB: Matrix3 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

const OKLAB_TO_LMS: Matrix3 = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];

const LMS_TO_LINEAR_RGB: Matrix3 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

function dotProduct(row: Vector3, vector: Vector3): number {
  const [r0, r1, r2] = row;
  const [v0, v1, v2] = vector;
  return r0 * v0 + r1 * v1 + r2 * v2;
}

function applyMatrix3(matrix: Matrix3, vector: Vector3): Vector3 {
  const [row0, row1, row2] = matrix;
  return [dotProduct(row0, vector), dotProduct(row1, vector), dotProduct(row2, vector)];
}

function cubeRoot3(vector: Vector3): Vector3 {
  const [v0, v1, v2] = vector;
  return [Math.cbrt(v0), Math.cbrt(v1), Math.cbrt(v2)];
}

function cube3(vector: Vector3): Vector3 {
  const [v0, v1, v2] = vector;
  return [v0 ** 3, v1 ** 3, v2 ** 3];
}

function srgbChannelToLinear(value: number): number {
  return value <= SRGB_DECODE_THRESHOLD ? value / 12.92 : ((value + 0.055) / 1.055) ** SRGB_GAMMA;
}

function linearChannelToSrgb(value: number): number {
  return value <= SRGB_ENCODE_THRESHOLD ? value * 12.92 : 1.055 * value ** (1 / SRGB_GAMMA) - 0.055;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeHueDegrees(hue: number): number {
  return ((hue % DEGREES_PER_TURN) + DEGREES_PER_TURN) % DEGREES_PER_TURN;
}

function labToOklch(lab: Vector3): Oklch {
  const [l, a, b] = lab;
  const c = Math.hypot(a, b);

  if (c < HUE_EPSILON) {
    return { l, c: 0, h: 0 };
  }

  const h = normalizeHueDegrees((Math.atan2(b, a) * DEGREES_PER_TURN) / (2 * Math.PI));
  return { l, c, h };
}

/**
 * Converts an sRGB color to OKLCH. Alpha is not part of OKLCH and is
 * dropped — callers that need to preserve it track it separately.
 *
 * @example rgbaToOklch({ r: 255, g: 0, b: 0, a: 1 }) // ~{ l: 0.628, c: 0.258, h: 29.2 }
 */
export function rgbaToOklch(color: RgbaColor): Oklch {
  const linearRgb: Vector3 = [
    srgbChannelToLinear(color.r / 255),
    srgbChannelToLinear(color.g / 255),
    srgbChannelToLinear(color.b / 255),
  ];

  const lms = cubeRoot3(applyMatrix3(LINEAR_RGB_TO_LMS, linearRgb));
  const lab = applyMatrix3(LMS_TO_OKLAB, lms);

  return labToOklch(lab);
}

/**
 * Converts an OKLCH color to sRGB, clamped to the valid channel range.
 * Always returns fully opaque (`a: 1`) — OKLCH itself carries no alpha.
 * `color.h` is normalized to [0, 360) before use, so an out-of-range or
 * wrapped hue (e.g. 540, equivalent to 180) produces the same result as its
 * normalized form.
 *
 * @example oklchToRgba({ l: 0.628, c: 0.258, h: 29.2 }) // ~{ r: 255, g: 0, b: 0, a: 1 }
 */
export function oklchToRgba(color: Oklch): RgbaColor {
  const hue = normalizeHueDegrees(color.h);
  const hueRadians = (hue * 2 * Math.PI) / DEGREES_PER_TURN;
  const oklab: Vector3 = [color.l, color.c * Math.cos(hueRadians), color.c * Math.sin(hueRadians)];

  const lms = cube3(applyMatrix3(OKLAB_TO_LMS, oklab));
  const linearRgb = applyMatrix3(LMS_TO_LINEAR_RGB, lms);
  const [r, g, b] = linearRgb;

  return {
    r: clampChannel(linearChannelToSrgb(r) * 255),
    g: clampChannel(linearChannelToSrgb(g) * 255),
    b: clampChannel(linearChannelToSrgb(b) * 255),
    a: 1,
  };
}

/**
 * The shortest angular distance between two hues, on the circular [0, 360)
 * hue wheel — never more than 180 (e.g. `hueDistance(10, 350)` is 20, not
 * 340, since going the other way around the wheel is shorter). Both inputs
 * are normalized first, so out-of-range or negative hues wrap correctly.
 *
 * @example hueDistance(350, 10) // 20
 */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeHueDegrees(a) - normalizeHueDegrees(b));
  return diff > 180 ? DEGREES_PER_TURN - diff : diff;
}
