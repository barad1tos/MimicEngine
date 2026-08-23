import { relativeLuminance } from '../../color/contrast';
import { rgbaToOklch } from '../../color/oklch';
import { isOpaque, type RgbaColor } from '../../color/parseColor';
import type { ThemeTokenName } from '../../themes';
import { BRAND_CHROMA_THRESHOLD } from '../colorMap';
import { ELEVATION_LEVELS, elevationVariable } from '../elevationScale';
import type { CustomPropertyFact, CustomPropertyUse } from '../pageFacts';
import type { PaletteEngine } from '../registry';
import { compareStrings } from '../sort';
import { groupSelectors, type StyleRule } from '../stylePlan';
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
type NameTableEntry = { pattern: RegExp; token: Classification };
type SurfaceCandidate = {
  property: ColoredProperty;
  isCanvasFamily: boolean;
  isStrongCanvas: boolean;
};
type ColorRole = 'background' | 'text' | 'border';

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

export const variableRemap: PaletteEngine = {
  id: 'variableRemap',
  label: 'Site variables',
  produce(theme, siteSettings, facts) {
    const aliases = deriveRoleAliases(
      facts.customProperties,
      theme.mode,
      siteSettings.preserveBrandColors,
    );
    const rules = buildUseRules(facts.customProperties, aliases);
    return {
      content: {
        kind: 'rules',
        rules: aliases.size === 0 ? [] : [buildAliasRule(aliases), ...rules],
      },
    };
  },
};

export function deriveRoleAliases(
  properties: CustomPropertyFact[],
  mode: 'dark' | 'light',
  preserveBrandColors: boolean,
): Map<string, string> {
  const rolesByProperty = collectRequestedRoles(properties);
  const directAssignments = new Map<string, Assignment>();
  const surfaceGroup: SurfaceCandidate[] = [];

  for (const property of properties.filter(hasOpaqueColor)) {
    if (isBrandProtected(property, preserveBrandColors)) continue;

    for (const role of rolesByProperty.get(property.name) ?? []) {
      const classification = classifyRole(property, role);
      if (classification === 'surface-group') {
        const nameMatch = matchNameTableEntry(property.name);
        const isCanvasFamily = nameMatch?.pattern === CANVAS_FAMILY_PATTERN;
        const isStrongCanvas = isCanvasFamily && isStrongCanvasName(property.name);
        surfaceGroup.push({ property, isCanvasFamily, isStrongCanvas });
      } else {
        directAssignments.set(roleAlias(role, property.name), classification);
      }
    }
  }

  assignSurfaceLadder(surfaceGroup, mode, directAssignments, (property) =>
    roleAlias('background', property.name),
  );
  return resolveRoleAliases(properties, rolesByProperty, directAssignments);
}

function collectRequestedRoles(
  properties: readonly CustomPropertyFact[],
): Map<string, Set<ColorRole>> {
  const roles = new Map<string, Set<ColorRole>>();
  const propertiesByName = new Map(properties.map((property) => [property.name, property]));
  const queue: { name: string; role: ColorRole }[] = [];

  for (const property of properties) {
    for (const use of property.uses) {
      if (use.bucket !== 'other') queue.push({ name: property.name, role: use.bucket });
    }
  }

  while (queue.length > 0) {
    const request = queue.shift();
    if (!request) break;
    const requested = roles.get(request.name) ?? new Set<ColorRole>();
    if (requested.has(request.role)) continue;
    requested.add(request.role);
    roles.set(request.name, requested);

    for (const reference of propertiesByName.get(request.name)?.references ?? []) {
      queue.push({ name: reference, role: request.role });
    }
  }

  return roles;
}

function classifyRole(property: ColoredProperty, role: ColorRole): Classification {
  const nameToken = matchNameTableEntry(property.name)?.token;
  if (
    nameToken &&
    nameToken !== 'surface-group' &&
    nameToken !== 'text' &&
    nameToken !== 'textMuted' &&
    nameToken !== 'border'
  ) {
    return nameToken;
  }
  if (role === 'background') return nameToken === 'surface-group' ? nameToken : 'surface-group';
  if (role === 'border') return nameToken === 'border' ? nameToken : 'border';
  if (nameToken === 'textMuted') return nameToken;
  return 'text';
}

function roleAlias(role: ColorRole, name: string): string {
  const prefix = role === 'background' ? 'bg' : role;
  return `--pm-${prefix}${name}`;
}

function resolveRoleAliases(
  properties: readonly CustomPropertyFact[],
  rolesByProperty: ReadonlyMap<string, ReadonlySet<ColorRole>>,
  directAssignments: ReadonlyMap<string, Assignment>,
): Map<string, string> {
  const propertiesByName = new Map(properties.map((property) => [property.name, property]));
  const aliases = new Map<string, string>();

  const resolve = (
    name: string,
    role: ColorRole,
    stack: Set<string>,
    pending: Map<string, string>,
  ): string | null => {
    const alias = roleAlias(role, name);
    if (aliases.has(alias) || pending.has(alias)) return alias;
    const directAssignment = directAssignments.get(alias);
    if (directAssignment !== undefined) {
      pending.set(alias, `var(${cssVariableFor(directAssignment)})`);
      return alias;
    }

    const property = propertiesByName.get(name);
    if (!property || property.references.length === 0 || stack.has(alias)) return null;
    stack.add(alias);
    const referencesResolved = property.references.every(
      (reference) => resolve(reference, role, stack, pending) !== null,
    );
    stack.delete(alias);
    if (!referencesResolved) return null;

    const availableAliases = new Map([...aliases, ...pending]);
    pending.set(alias, replaceRoleReferences(property.value, role, availableAliases));
    return alias;
  };

  for (const property of properties) {
    for (const role of consumerRoles(property)) {
      const pending = new Map<string, string>();
      if (resolve(property.name, role, new Set(), pending) === null) continue;
      for (const [alias, value] of pending) aliases.set(alias, value);
    }
  }

  return aliases;
}

function consumerRoles(property: CustomPropertyFact): ColorRole[] {
  const roles = new Set<ColorRole>();
  for (const use of property.uses) {
    if (use.bucket !== 'other') roles.add(use.bucket);
  }
  return [...roles];
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
  assignmentName: (property: ColoredProperty) => string = (property) => property.name,
): void {
  const canvasWinner = pickCanvasWinner(surfaceGroup, mode);

  const remaining = surfaceGroup
    .filter((entry) => entry !== canvasWinner)
    .sort((a, b) => luminanceOrder(a.property, b.property, mode));

  const ordered = canvasWinner ? [canvasWinner, ...remaining] : remaining;
  ordered.forEach(({ property }, index) => {
    assignments.set(assignmentName(property), clampSurfaceLevel(index));
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

function buildAliasRule(aliases: ReadonlyMap<string, string>): StyleRule {
  return {
    conditions: [],
    selector: 'html',
    declarations: new Map(aliases),
  };
}

const CUSTOM_PROPERTY_PATTERN = /var\((\s*)(--[\w-]+)/gi;

function buildUseRules(
  properties: readonly CustomPropertyFact[],
  aliases: ReadonlyMap<string, string>,
): StyleRule[] {
  const declarations = new Map<string, CustomPropertyUse>();
  for (const property of properties) {
    for (const use of property.uses) {
      const key = `${JSON.stringify(use.conditions)}|${use.selector}|${use.property}|${use.value}`;
      declarations.set(key, use);
    }
  }

  const resolved = [...declarations.values()].flatMap((declaration) => {
    if (declaration.bucket === 'other') return [];
    const mappedValue = declaration.value.replace(
      CUSTOM_PROPERTY_PATTERN,
      (match, whitespace: string, name: string) => {
        const alias = roleAlias(declaration.bucket as ColorRole, name);
        if (!aliases.has(alias)) return match;
        return `var(${whitespace}${alias}`;
      },
    );
    return mappedValue === declaration.value
      ? []
      : [{ declaration, mappedValue, isSelectorHint: false }];
  });

  return groupSelectors(resolved);
}

function replaceRoleReferences(
  value: string,
  role: ColorRole,
  aliases: ReadonlyMap<string, string>,
): string {
  return value.replace(CUSTOM_PROPERTY_PATTERN, (match, whitespace: string, name: string) => {
    const alias = roleAlias(role, name);
    return aliases.has(alias) ? `var(${whitespace}${alias}` : match;
  });
}
