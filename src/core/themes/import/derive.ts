// Ordered OKLCH gap derivation: fills every theme token slots.tokens leaves
// empty, using canvas/text as the two terminal primaries and (when present)
// the ANSI palette for accent-family colors. Source tokens are never
// overwritten — monotonicity is the whole point of a "gap fill" pass.

import { contrastRatio } from '../../color/contrast';
import { oklchToRgba, rgbaToOklch, type Oklch } from '../../color/oklch';
import { parseCssColor, toHex, type RgbaColor } from '../../color/parseColor';
import { THEME_TOKEN_NAMES, type ThemeTokenName, type ThemeTokens } from '../themeTypes';
import type { ImportError, ThemeSlots } from './importTypes';

export type DeriveResult =
  | { tokens: ThemeTokens; mode: 'dark' | 'light'; derivedTokens: readonly ThemeTokenName[] }
  | ImportError;

type MutableTokens = Partial<Record<ThemeTokenName, string>>;
type LadderSlotName = 'surface1' | 'surface2' | 'surface3' | 'border';
type StatusSlotName = 'success' | 'warning' | 'danger';
type AccentSlotName = 'accent' | 'link' | StatusSlotName;

type PrimariesResolution = {
  canvasHex: string;
  canvasOklch: Oklch;
  textHex: string;
  textOklch: Oklch;
  span: number;
  derivedPrimaries: readonly ThemeTokenName[];
};

// Surface ladder + border fractions of the canvas->text span (rule 3).
const SURFACE_LADDER: readonly (readonly [LadderSlotName, number])[] = [
  ['surface1', 0.08],
  ['surface2', 0.16],
  ['surface3', 0.24],
  ['border', 0.32],
];

const TEXT_MUTED_FRACTION = 0.7; // rule 4
const SELECTION_FRACTION = 0.2; // rule 7

// Reference hues used when a status token has no source at all (rule 6).
const STATUS_REFERENCE_HUE: readonly (readonly [StatusSlotName, number])[] = [
  ['success', 145],
  ['warning', 85],
  ['danger', 25],
];

// ANSI slot pairs (dim/bright) per accent-family token (rule 5).
const ANSI_ACCENT_GROUP: readonly {
  readonly name: AccentSlotName;
  readonly low: number;
  readonly high: number;
}[] = [
  { name: 'accent', low: 4, high: 12 },
  { name: 'link', low: 6, high: 14 },
  { name: 'success', low: 2, high: 10 },
  { name: 'warning', low: 3, high: 11 },
  { name: 'danger', low: 1, high: 9 },
];

const FLOOR_TOKENS: readonly AccentSlotName[] = ANSI_ACCENT_GROUP.map((slot) => slot.name);
const CONTRAST_FLOOR = 3;
const FLOOR_LIGHTNESS_STEP = 0.02;
const FLOOR_MAX_STEPS = 25;

function clampLightness(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hexFromOklch(oklch: Oklch): string {
  return toHex(oklchToRgba(oklch));
}

function deriveError(message: string): ImportError {
  return { stage: 'derive', message };
}

type PrimaryColorResolution =
  { kind: 'ok'; hex: string; rgba: RgbaColor } | { kind: 'missing' } | { kind: 'invalid' };

function resolvePrimaryColor(hex: string | undefined): PrimaryColorResolution {
  if (hex === undefined) return { kind: 'missing' };
  const rgba = parseCssColor(hex);
  return rgba ? { kind: 'ok', hex, rgba } : { kind: 'invalid' };
}

// Distinguishes a key that was never provided from one that was provided but
// didn't parse, so callers can tell "add the field" from "fix the value"
// apart. Both lists collapse into one message when both cases occur.
function formatPrimariesError(missing: readonly string[], invalid: readonly string[]): string {
  if (missing.length > 0 && invalid.length > 0) {
    return `missing: ${missing.join(', ')}; invalid: ${invalid.join(', ')}`;
  }
  if (invalid.length > 0) {
    return `invalid canvas/text primaries: ${invalid.join(', ')}`;
  }
  return `missing canvas/text primaries: ${missing.join(', ')}`;
}

// Rules 1-2: terminal primaries (canvas <- background, text <- foreground,
// gap-fill only) plus the span they define. Missing/unparseable primaries
// short-circuit derivation entirely — everything downstream needs both.
function resolvePrimaries(slots: ThemeSlots): PrimariesResolution | ImportError {
  const canvas = resolvePrimaryColor(slots.tokens.canvas ?? slots.background);
  const text = resolvePrimaryColor(slots.tokens.text ?? slots.foreground);

  const missing: string[] = [];
  const invalid: string[] = [];
  if (canvas.kind === 'missing') missing.push('canvas');
  if (canvas.kind === 'invalid') invalid.push('canvas');
  if (text.kind === 'missing') missing.push('text');
  if (text.kind === 'invalid') invalid.push('text');

  if (canvas.kind !== 'ok' || text.kind !== 'ok') {
    return deriveError(formatPrimariesError(missing, invalid));
  }

  const canvasOklch = rgbaToOklch(canvas.rgba);
  const textOklch = rgbaToOklch(text.rgba);
  const derivedPrimaries: ThemeTokenName[] = [];
  if (slots.tokens.canvas === undefined) derivedPrimaries.push('canvas');
  if (slots.tokens.text === undefined) derivedPrimaries.push('text');

  return {
    canvasHex: canvas.hex,
    canvasOklch,
    textHex: text.hex,
    textOklch,
    span: textOklch.l - canvasOklch.l,
    derivedPrimaries,
  };
}

// Rule 2: explicit source metadata wins; otherwise infer from canvas lightness.
function resolveMode(
  explicitMode: 'dark' | 'light' | undefined,
  canvasL: number,
): 'dark' | 'light' {
  return explicitMode ?? (canvasL < 0.5 ? 'dark' : 'light');
}

// Rule 3: surface1/2/3 and border, hue/chroma of canvas preserved.
function fillSurfaceLadder(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  canvasOklch: Oklch,
  span: number,
): void {
  for (const [name, fraction] of SURFACE_LADDER) {
    if (tokens[name] !== undefined) continue;
    const l = clampLightness(canvasOklch.l + fraction * span);
    tokens[name] = hexFromOklch({ l, c: canvasOklch.c, h: canvasOklch.h });
    derived.add(name);
  }
}

// Rule 4: textMuted, hue/chroma of text preserved.
function fillTextMuted(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  canvasOklch: Oklch,
  textOklch: Oklch,
  span: number,
): void {
  if (tokens.textMuted !== undefined) return;
  const l = clampLightness(canvasOklch.l + TEXT_MUTED_FRACTION * span);
  tokens.textMuted = hexFromOklch({ l, c: textOklch.c, h: textOklch.h });
  derived.add('textMuted');
}

// Of an ANSI dim/bright pair, pick the member with higher contrast against
// canvas; an unparseable or absent member loses to a usable one.
function pickAnsiCandidate(
  ansi: readonly (string | undefined)[],
  lowIndex: number,
  highIndex: number,
  canvasHex: string,
): string | undefined {
  const low = ansi[lowIndex];
  const high = ansi[highIndex];
  const lowRatio = low !== undefined ? contrastRatio(low, canvasHex) : null;
  const highRatio = high !== undefined ? contrastRatio(high, canvasHex) : null;

  if (highRatio === null) return lowRatio === null ? undefined : low;
  if (lowRatio === null) return high;
  return highRatio > lowRatio ? high : low;
}

// Rule 5: accent/link/success/warning/danger from ANSI, gap-fill only.
function fillAccentGroupFromAnsi(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  ansi: readonly (string | undefined)[],
  canvasHex: string,
): void {
  for (const slot of ANSI_ACCENT_GROUP) {
    if (tokens[slot.name] !== undefined) continue;
    const candidate = pickAnsiCandidate(ansi, slot.low, slot.high, canvasHex);
    if (candidate === undefined) continue;
    tokens[slot.name] = candidate;
    derived.add(slot.name);
  }
}

type ResolvedAccent = { hex: string; oklch: Oklch };

// Rule 7's guard: everything past this point (status reference hue, link
// fallback, selection, focus) is anchored on accent, so an accent that
// never resolved (no source token, no usable ANSI blue) is fatal. Returns
// the hex alongside its OKLCH decomposition — callers need both, and this
// is the one place `tokens.accent` is confirmed defined.
function resolveAccentOklch(tokens: MutableTokens): ResolvedAccent | ImportError {
  const accentHex = tokens.accent;
  if (accentHex === undefined) {
    return deriveError('no accent source (provide focusColor/button/ANSI blue)');
  }
  const rgba = parseCssColor(accentHex);
  if (!rgba) {
    return deriveError(`invalid accent color: ${accentHex}`);
  }
  return { hex: accentHex, oklch: rgbaToOklch(rgba) };
}

// Rule 6: a status token with no source at all (no token, no ANSI candidate)
// takes its reference hue with accent's lightness/chroma.
function fillStatusReferenceHue(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  accentOklch: Oklch,
): void {
  for (const [name, hue] of STATUS_REFERENCE_HUE) {
    if (tokens[name] !== undefined) continue;
    tokens[name] = hexFromOklch({ l: accentOklch.l, c: accentOklch.c, h: hue });
    derived.add(name);
  }
}

// link has no reference-hue fallback of its own (rule 6 only names the
// status tokens); when ANSI cyan didn't provide it either, it defaults to
// accent — the same gap-fill accent gets for focus in rule 7.
function fillLinkFallback(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  accentHex: string,
): void {
  if (tokens.link !== undefined) return;
  tokens.link = accentHex;
  derived.add('link');
}

// Rule 7 (selection half): accent hue/chroma at canvas L+0.20*S. Selection is
// exempt from the rule 8 floor (see applyContrastFloor), so its timing
// relative to that pass doesn't matter — it stays here, alongside accent's
// other rule-7 derivations.
function fillSelection(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  accent: ResolvedAccent,
  canvasOklch: Oklch,
  span: number,
): void {
  if (tokens.selection !== undefined) return;
  const l = clampLightness(canvasOklch.l + SELECTION_FRACTION * span);
  tokens.selection = hexFromOklch({ l, c: accent.oklch.c, h: accent.oklch.h });
  derived.add('selection');
}

// Rule 7 (focus half): focus = accent. Deliberately called AFTER
// applyContrastFloor (rule 8) — focus must mirror the FINAL accent value,
// so if accent needed floor repair, focus takes the repaired hex, never the
// pre-repair one. Reads `tokens.accent` directly (not the `accent` parameter
// captured before repair) for exactly this reason.
function fillFocus(tokens: MutableTokens, derived: Set<ThemeTokenName>): void {
  if (tokens.focus !== undefined) return;
  const accentHex = tokens.accent;
  if (accentHex === undefined) return; // unreachable: accent resolved earlier in the pipeline
  tokens.focus = accentHex;
  derived.add('focus');
}

// Mirrors contrastGuard's stepAwayFromBackground shape (direction away from
// the reference lightness, magnitude step * iteration), with this rule's own
// step size and ceiling (rule 8) rather than contrastGuard's text-repair ones.
function stepAwayFromCanvas(oklch: Oklch, canvasL: number, step: number): Oklch {
  const direction = oklch.l >= canvasL ? 1 : -1;
  const l = clampLightness(oklch.l + direction * FLOOR_LIGHTNESS_STEP * step);
  return { l, c: oklch.c, h: oklch.h };
}

// Steps `hex` away from canvas lightness, hue/chroma fixed, until it clears
// the 3:1 floor or the step budget runs out (best-effort candidate wins).
function repairToFloor(hex: string, canvasHex: string, canvasL: number): string {
  if ((contrastRatio(hex, canvasHex) ?? 0) >= CONTRAST_FLOOR) return hex;

  const rgba = parseCssColor(hex);
  if (!rgba) return hex;

  const oklch = rgbaToOklch(rgba);
  let bestCandidate = hex;

  for (let step = 1; step <= FLOOR_MAX_STEPS; step += 1) {
    const candidateHex = hexFromOklch(stepAwayFromCanvas(oklch, canvasL, step));
    bestCandidate = candidateHex;
    if ((contrastRatio(candidateHex, canvasHex) ?? 0) >= CONTRAST_FLOOR) return candidateHex;
  }

  return bestCandidate;
}

// Rule 8: every DERIVED accent-family token below 3:1 vs canvas gets
// lightness-stepped until it clears the floor. Source tokens (never in
// `derived`) and selection (not in FLOOR_TOKENS) are exempt.
function applyContrastFloor(
  tokens: MutableTokens,
  derived: Set<ThemeTokenName>,
  canvasHex: string,
  canvasL: number,
): void {
  for (const name of FLOOR_TOKENS) {
    if (!derived.has(name)) continue;
    const hex = tokens[name];
    if (hex === undefined) continue;
    tokens[name] = repairToFloor(hex, canvasHex, canvasL);
  }
}

// Type-level completeness proof: every branch above accounts for one of the
// 14 tokens once accent resolves, but Partial<Record<...>> can't express
// that structurally — this is the narrowing step that lets the return type
// be the total ThemeTokens without a cast.
function isCompleteThemeTokens(tokens: MutableTokens): tokens is ThemeTokens {
  return THEME_TOKEN_NAMES.every((name) => tokens[name] !== undefined);
}

export function deriveGaps(slots: ThemeSlots): DeriveResult {
  const primaries = resolvePrimaries(slots);
  if ('stage' in primaries) return primaries;

  const { canvasHex, canvasOklch, textHex, textOklch, span, derivedPrimaries } = primaries;
  const tokens: MutableTokens = { ...slots.tokens, canvas: canvasHex, text: textHex };
  const derived = new Set<ThemeTokenName>(derivedPrimaries);

  fillSurfaceLadder(tokens, derived, canvasOklch, span);
  fillTextMuted(tokens, derived, canvasOklch, textOklch, span);
  fillAccentGroupFromAnsi(tokens, derived, slots.ansi ?? [], canvasHex);

  const accent = resolveAccentOklch(tokens);
  if ('stage' in accent) return accent;

  fillStatusReferenceHue(tokens, derived, accent.oklch);
  fillLinkFallback(tokens, derived, accent.hex);
  fillSelection(tokens, derived, accent, canvasOklch, span);
  applyContrastFloor(tokens, derived, canvasHex, canvasOklch.l);
  fillFocus(tokens, derived);

  if (!isCompleteThemeTokens(tokens)) {
    return deriveError('internal: derivation left a token unset');
  }

  return {
    tokens,
    mode: resolveMode(slots.mode, canvasOklch.l),
    derivedTokens: THEME_TOKEN_NAMES.filter((name) => derived.has(name)),
  };
}
