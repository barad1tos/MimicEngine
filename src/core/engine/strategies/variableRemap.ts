import { relativeLuminance } from '../../color/contrast';
import { rgbaToOklch } from '../../color/oklch';
import { isOpaque, type RgbaColor } from '../../color/parseColor';
import type { ThemeTokenName } from '../../themes';
import { BRAND_CHROMA_THRESHOLD } from '../colorMap';
import { ELEVATION_LEVELS, elevationVariable } from '../elevationScale';
import type { CustomPropertyFact } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { tokenToCssVariableSuffix } from '../tokenVariables';

type DirectToken = Exclude<ThemeTokenName, 'canvas' | 'surface1' | 'surface2' | 'surface3'>;
type Classification = DirectToken | 'surface-group';
// The final value recorded for one custom property: a direct theme token, or
// an elevation LEVEL (0..ELEVATION_LEVELS - 1) for a surface-group entry —
// Amendment 3 routes the surface ladder through the universal elevation ramp,
// never the theme's own surface1-3 tokens (colorMap.ts's background ladder
// does the same; see assignLadder there).
type Assignment = DirectToken | number;
type ColoredProperty = CustomPropertyFact & { color: RgbaColor };
type UsageKey = keyof CustomPropertyFact['usage'];
type NameTableEntry = { pattern: RegExp; token: Classification };
type SurfaceCandidate = {
  property: ColoredProperty;
  isCanvasFamily: boolean;
  isStrongCanvas: boolean;
};

// Surface-group entries whose name matched this pattern outrank other
// surface-group entries for the ladder's `canvas` slot (see
// assignSurfaceLadder) when no STRONG_CANVAS_PATTERN match exists.
const CANVAS_FAMILY_PATTERN = /background|canvas|page|body|bg/i;

// A stricter subset of CANVAS_FAMILY_PATTERN: `page`, `body`, or `canvas` as
// a whole hyphen-delimited word, not merely a `bg` suffix. Every `*-bg`
// variable (`--page-bg`, `--panel-bg`, `--card-bg`, ...) matches
// CANVAS_FAMILY_PATTERN, which would make the canvas-family tie-break a
// no-op on real pages — pure luminance would still decide among a page,
// panel, and card that all happen to be named `*-bg`. This pattern isolates
// the entries that are unambiguously the page/body/canvas itself, and those
// win the canvas slot ahead of any other canvas-family entry.
const STRONG_CANVAS_PATTERN = /(^|-)(page|body|canvas)(-|$)/i;

// First match wins; order is part of the classification contract.
const NAME_TABLE: readonly NameTableEntry[] = [
  { pattern: /danger|error|destructive/i, token: 'danger' },
  { pattern: /warn|caution/i, token: 'warning' },
  { pattern: /success|positive/i, token: 'success' },
  { pattern: /link/i, token: 'link' },
  { pattern: /accent|primary|brand/i, token: 'accent' },
  { pattern: /focus|ring/i, token: 'focus' },
  { pattern: /selection|highlight/i, token: 'selection' },
  { pattern: /muted|secondary|subtle|dim/i, token: 'textMuted' },
  { pattern: /border|divider|outline|stroke/i, token: 'border' },
  { pattern: /text|foreground|fg|ink/i, token: 'text' },
  { pattern: CANVAS_FAMILY_PATTERN, token: 'surface-group' },
  { pattern: /surface|panel|card|elevated/i, token: 'surface-group' },
];

const USAGE_TOKEN_MAP: Record<'background' | 'text' | 'border', Classification> = {
  background: 'surface-group',
  text: 'text',
  border: 'border',
};

export const variableRemap: PaletteEngine = {
  id: 'variableRemap',
  label: 'Site variables',
  produce(theme, siteSettings, facts) {
    const assignments = assignTokens(
      facts.customProperties,
      theme.mode,
      siteSettings.preserveBrandColors,
    );
    return { css: assignments.size === 0 ? '' : emitCss(assignments) };
  },
};

export function assignTokens(
  properties: CustomPropertyFact[],
  mode: 'dark' | 'light',
  preserveBrandColors: boolean,
): Map<string, Assignment> {
  const assignments = new Map<string, Assignment>();
  const surfaceGroup: SurfaceCandidate[] = [];

  for (const property of properties.filter(hasOpaqueColor)) {
    if (isBrandProtected(property, preserveBrandColors)) continue;

    const nameMatch = matchNameTableEntry(property.name);
    const classification = nameMatch?.token ?? classifyUsage(property.usage);
    if (classification === 'surface-group') {
      const isCanvasFamily = nameMatch?.pattern === CANVAS_FAMILY_PATTERN;
      const isStrongCanvas = isCanvasFamily && isStrongCanvasName(property.name);
      surfaceGroup.push({ property, isCanvasFamily, isStrongCanvas });
    } else if (classification !== null) {
      assignments.set(property.name, classification);
    }
  }

  assignSurfaceLadder(surfaceGroup, mode, assignments);

  return assignments;
}

// Same opacity gate M2 gives authoredRemap/computedFallback: a translucent
// declaration (e.g. a modal scrim) must never stand in for the page's actual
// opaque surface color once reduced through toHex downstream.
function hasOpaqueColor(property: CustomPropertyFact): property is ColoredProperty {
  return property.color !== null && isOpaque(property.color);
}

// Mirrors mapAccent's exemption (colorMap.ts): when the site owner asked to
// preserve brand colors, a vivid (accent-family) custom property is excluded
// from token assignment entirely — its authored value stays, brand intact.
// Muted surfaces/text-ish properties are unaffected either way.
function isBrandProtected(property: ColoredProperty, preserveBrandColors: boolean): boolean {
  return preserveBrandColors && rgbaToOklch(property.color).c > BRAND_CHROMA_THRESHOLD;
}

function matchNameTableEntry(name: string): NameTableEntry | null {
  return NAME_TABLE.find(({ pattern }) => pattern.test(name)) ?? null;
}

// STRONG_CANVAS_PATTERN is checked against the name without its leading
// `--`, so `(^|-)` also anchors on the property's very first segment.
function isStrongCanvasName(name: string): boolean {
  const bareName = name.startsWith('--') ? name.slice(2) : name;
  return STRONG_CANVAS_PATTERN.test(bareName);
}

function classifyUsage(usage: CustomPropertyFact['usage']): Classification | null {
  const counts: readonly [UsageKey, number][] = [
    ['background', usage.background],
    ['text', usage.text],
    ['border', usage.border],
    ['other', usage.other],
  ];
  const max = Math.max(...counts.map(([, count]) => count));
  if (max === 0) return null;

  const winners = counts.filter(([, count]) => count === max);
  if (winners.length !== 1) return null;

  const winner = winners[0];
  if (winner === undefined) return null;

  const [key] = winner;
  return key === 'other' ? null : USAGE_TOKEN_MAP[key];
}

// The single ground slot (elevation 0) goes to the top (by luminance)
// candidate from the highest-priority non-empty tier: STRONG_CANVAS_PATTERN
// names first (--page-bg over a --panel-bg/--card-bg sibling, even though all
// three are canvas-family by the broader pattern), then any other
// canvas-family name, then no name-based winner at all. Every other candidate
// (runners-up from the winning tier, plus everyone else) fills elevation
// levels 1..3 (Amendment 3: the universal ramp, not the theme's own
// surface1-3 tokens) by the existing luminance order.
function assignSurfaceLadder(
  surfaceGroup: readonly SurfaceCandidate[],
  mode: 'dark' | 'light',
  assignments: Map<string, Assignment>,
): void {
  const canvasWinner = pickCanvasWinner(surfaceGroup, mode);

  const remaining = surfaceGroup
    .filter((entry) => entry !== canvasWinner)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));

  const ordered = canvasWinner ? [canvasWinner, ...remaining] : remaining;
  ordered.forEach(({ property }, index) => {
    assignments.set(property.name, clampSurfaceLevel(index));
  });
}

function pickCanvasWinner(
  surfaceGroup: readonly SurfaceCandidate[],
  mode: 'dark' | 'light',
): SurfaceCandidate | undefined {
  const strong = surfaceGroup
    .filter((entry) => entry.isStrongCanvas)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));
  if (strong.length > 0) return strong[0];

  const canvasFamily = surfaceGroup
    .filter((entry) => entry.isCanvasFamily)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));
  return canvasFamily[0];
}

function luminanceOrder(a: ColoredProperty, b: ColoredProperty, mode: 'dark' | 'light'): number {
  const direction = mode === 'dark' ? 1 : -1;
  const luminanceDelta = (relativeLuminance(a.color) - relativeLuminance(b.color)) * direction;
  return luminanceDelta !== 0 ? luminanceDelta : compareStrings(a.name, b.name);
}

// The elevation ramp's rung index for a surface-group ladder position,
// clamped to the ramp's own top level — same clamp semantics colorMap.ts's
// clampLadderLevel applies to a census-sourced elevation.
function clampSurfaceLevel(index: number): number {
  return Math.min(index, ELEVATION_LEVELS - 1);
}

function cssVariableFor(assignment: Assignment): string {
  return typeof assignment === 'number'
    ? elevationVariable(assignment)
    : `--pm-${tokenToCssVariableSuffix(assignment)}`;
}

function emitCss(assignments: Map<string, Assignment>): string {
  const declarations = [...assignments.entries()]
    .sort(([nameA], [nameB]) => compareStrings(nameA, nameB))
    .map(([name, assignment]) => `  ${name}: var(${cssVariableFor(assignment)}) !important;`)
    .join('\n');

  return `html[data-pm-active="true"] {\n${declarations}\n}`;
}
