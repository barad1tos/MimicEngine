import { relativeLuminance } from '../../color/contrast';
import type { RgbaColor } from '../../color/parseColor';
import type { ThemeTokenName } from '../../themes';
import type { CustomPropertyFact } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { tokenToCssVariableSuffix } from '../tokenVariables';

type DirectToken = Exclude<ThemeTokenName, 'canvas' | 'surface1' | 'surface2' | 'surface3'>;
type Classification = DirectToken | 'surface-group';
type ColoredProperty = CustomPropertyFact & { color: RgbaColor };
type UsageKey = keyof CustomPropertyFact['usage'];
type NameTableEntry = { pattern: RegExp; token: Classification };
type SurfaceCandidate = { property: ColoredProperty; isCanvasPriority: boolean };

// Surface-group entries whose name matched this pattern outrank every other
// surface-group entry for the ladder's `canvas` slot (see assignSurfaceLadder).
const CANVAS_FAMILY_PATTERN = /background|canvas|page|body|bg/i;

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

const SURFACE_LADDER: readonly ThemeTokenName[] = ['canvas', 'surface1', 'surface2', 'surface3'];

export const variableRemap: PaletteEngine = {
  id: 'variableRemap',
  label: 'Site variables',
  produceCss(theme, _siteSettings, facts) {
    const assignments = assignTokens(facts.customProperties, theme.mode);
    return assignments.size === 0 ? '' : emitCss(assignments);
  },
};

export function assignTokens(
  properties: CustomPropertyFact[],
  mode: 'dark' | 'light',
): Map<string, ThemeTokenName> {
  const assignments = new Map<string, ThemeTokenName>();
  const surfaceGroup: SurfaceCandidate[] = [];

  for (const property of properties.filter(hasColor)) {
    const nameMatch = matchNameTableEntry(property.name);
    const classification = nameMatch?.token ?? classifyUsage(property.usage);
    if (classification === 'surface-group') {
      const isCanvasPriority = nameMatch?.pattern === CANVAS_FAMILY_PATTERN;
      surfaceGroup.push({ property, isCanvasPriority });
    } else if (classification !== null) {
      assignments.set(property.name, classification);
    }
  }

  assignSurfaceLadder(surfaceGroup, mode, assignments);

  return assignments;
}

function hasColor(property: CustomPropertyFact): property is ColoredProperty {
  return property.color !== null;
}

function matchNameTableEntry(name: string): NameTableEntry | null {
  return NAME_TABLE.find(({ pattern }) => pattern.test(name)) ?? null;
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

// The single `canvas` slot goes to the top (by luminance) candidate among
// entries whose NAME matched the canvas-family pattern, if any exist —
// site authors that name a variable `--page-bg` mean it as the page
// canvas, regardless of how its lightness compares to a `--card-panel`
// that only matched the broader surface-family pattern. Every other
// candidate (canvas-family runners-up plus the rest) then fills
// surface1..3 by the existing luminance order.
function assignSurfaceLadder(
  surfaceGroup: readonly SurfaceCandidate[],
  mode: 'dark' | 'light',
  assignments: Map<string, ThemeTokenName>,
): void {
  const canvasCandidates = surfaceGroup
    .filter((entry) => entry.isCanvasPriority)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));
  const canvasWinner = canvasCandidates[0];

  const remaining = surfaceGroup
    .filter((entry) => entry !== canvasWinner)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));

  const ordered = canvasWinner ? [canvasWinner, ...remaining] : remaining;
  ordered.forEach(({ property }, index) => {
    assignments.set(property.name, surfaceTokenAt(index));
  });
}

function luminanceOrder(a: ColoredProperty, b: ColoredProperty, mode: 'dark' | 'light'): number {
  const direction = mode === 'dark' ? 1 : -1;
  const luminanceDelta = (relativeLuminance(a.color) - relativeLuminance(b.color)) * direction;
  return luminanceDelta !== 0 ? luminanceDelta : compareStrings(a.name, b.name);
}

function surfaceTokenAt(index: number): ThemeTokenName {
  const clampedIndex = Math.min(index, SURFACE_LADDER.length - 1);
  return SURFACE_LADDER[clampedIndex] ?? 'surface3';
}

function emitCss(assignments: Map<string, ThemeTokenName>): string {
  const declarations = [...assignments.entries()]
    .sort(([nameA], [nameB]) => compareStrings(nameA, nameB))
    .map(([name, token]) => `  ${name}: var(--pm-${tokenToCssVariableSuffix(token)}) !important;`)
    .join('\n');

  return `html[data-pm-active="true"] {\n${declarations}\n}`;
}
