import type { PaletteTheme } from '../themes';
import type { SiteOverride } from '../storage/settingsStore';
import { elevationVariable } from '../engine/elevationScale';
import { tokenToCssVariableSuffix } from '../engine/tokenVariables';

const ACTIVE_GATE = 'html[data-pm-active="true"]';

// One rule's selectors, expressed relative to the active-document gate: ''
// means "the gated element itself" (only meaningful in the gated flavor —
// buildUngatedBaseRules drops it, see there for why), anything else is a
// descendant selector appended after the gate with a separating space.
type GatedRule = {
  readonly selectors: readonly string[];
  readonly declarations: readonly string[];
  // Amendment 2 (2026-08-21, signature-census-design.md): the generic
  // opaque-BACKGROUND readability net for button/input-shaped elements —
  // baseline's job when computedFallback can't see the page at all. When
  // computedFallback IS in the plan, the census already paints exactly the
  // surfaces genuinely opaque on the page; this floor then does nothing but
  // paint over transparent controls it has no business touching (the
  // LinkedIn top-bar hairline/checkerboard live finding). Marked ONLY on the
  // background declarations (base + :hover) — see the Codex P2 note above
  // the interactive-surface rules below for why color/border-color/
  // caret-color stay in a separate, unconditional rule instead of sharing
  // this flag. Every other rule (unmarked) is unconditional too.
  readonly interactiveFloor?: boolean;
};

const BASE_RULES: readonly GatedRule[] = [
  {
    selectors: ['', 'body'],
    declarations: [
      // Amendment 3 (2026-08-21, signature-census-design.md): the ground
      // rung of the universal elevation ramp, not the theme's own canvas
      // token directly -- elevation-0 IS the canvas verbatim
      // (elevationBackgroundHex), so this is byte-identical in value, just
      // resolved through the same ramp variableRemap's surface ladder and
      // computedFallback's background ladder now target.
      `background-color: var(${elevationVariable(0)}) !important;`,
      'color: var(--pm-text) !important;',
    ],
  },
  {
    selectors: ['body', 'main', 'article', 'section', 'aside', 'nav', 'header', 'footer'],
    declarations: ['border-color: var(--pm-border) !important;'],
  },
  {
    selectors: [
      ':where(p, span, li, dt, dd, label, summary, small, strong, em, h1, h2, h3, h4, h5, h6)',
    ],
    declarations: ['color: inherit;'],
  },
  {
    selectors: [':where(a, a:visited)'],
    declarations: ['color: var(--pm-link) !important;'],
  },
  {
    // Omittable: the only piece of the original combined rule computedFallback
    // genuinely supersedes — the census samples backgrounds itself, so a
    // page it can see needs no generic opaque-background assumption here.
    selectors: [':where(button, [role="button"], input, select, textarea)'],
    declarations: [`background-color: var(${elevationVariable(1)}) !important;`],
    interactiveFloor: true,
  },
  {
    // Codex P2 (PR #15): unconditional even when computedFallback runs.
    // color/border-color ARE census-sampled buckets (text/border), so
    // computedFallback's own later-in-source-order rule already overrides
    // these for any signature it actually emits a rule for — keeping them
    // here is a safe default, not a regression. caret-color is NEVER
    // census-sampled (sampledDeclarationsFor covers text/background/border
    // only) — nothing else can ever restore it, so it must never be tied to
    // the omittable background rule above, or an input's original caret can
    // end up invisible against the themed background.
    selectors: [':where(button, [role="button"], input, select, textarea)'],
    declarations: [
      'color: var(--pm-text) !important;',
      'border-color: var(--pm-border) !important;',
      'caret-color: var(--pm-accent) !important;',
    ],
  },
  {
    selectors: [
      ':where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover)',
    ],
    declarations: [`background-color: var(${elevationVariable(2)}) !important;`],
    interactiveFloor: true,
  },
  {
    selectors: [
      ':where(button:focus-visible, [role="button"]:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible)',
    ],
    declarations: [
      'outline: 2px solid var(--pm-focus) !important;',
      'outline-offset: 2px !important;',
    ],
  },
  {
    selectors: [':where(code, kbd, samp, pre)'],
    declarations: [
      `background-color: var(${elevationVariable(1)}) !important;`,
      'color: var(--pm-text) !important;',
      'border-color: var(--pm-border) !important;',
    ],
  },
  {
    selectors: [':where(table, thead, tbody, tr, td, th)'],
    declarations: ['border-color: var(--pm-border) !important;'],
  },
  {
    selectors: [':where(th)'],
    declarations: [
      `background-color: var(${elevationVariable(1)}) !important;`,
      'color: var(--pm-text) !important;',
    ],
  },
  {
    selectors: [':where(blockquote, details, dialog, fieldset, figure, form)'],
    declarations: [
      `background-color: var(${elevationVariable(1)}) !important;`,
      'color: var(--pm-text) !important;',
      'border-color: var(--pm-border) !important;',
    ],
  },
  {
    selectors: ['::selection'],
    declarations: [
      'background-color: var(--pm-selection) !important;',
      'color: var(--pm-text) !important;',
    ],
  },
];

function formatRule(selectors: readonly string[], declarations: readonly string[]): string {
  const body = declarations.map((declaration) => `  ${declaration}`).join('\n');
  return `${selectors.join(',\n')} {\n${body}\n}`;
}

export type BuildBaseStylesheetOptions = {
  // See GatedRule.interactiveFloor: true when the plan also runs
  // computedFallback, which paints exactly the surfaces genuinely opaque on
  // the page — the generic readability net would only paint over it.
  readonly omitInteractiveFloor?: boolean;
};

export function buildBaseStylesheet(
  _theme: PaletteTheme,
  options: BuildBaseStylesheetOptions = {},
): string {
  const rules = options.omitInteractiveFloor
    ? BASE_RULES.filter((rule) => !rule.interactiveFloor)
    : BASE_RULES;

  return rules
    .map((rule) =>
      formatRule(
        rule.selectors.map((selector) =>
          selector === '' ? ACTIVE_GATE : `${ACTIVE_GATE} ${selector}`,
        ),
        rule.declarations,
      ),
    )
    .join('\n\n');
}

// Ungated mirror of buildBaseStylesheet, consumed by shadowStyles.ts to build
// the shadow-root floor: inside a shadow tree the document activation gate
// (html[data-pm-active="true"]) can never match, so every selector loses its
// gate prefix. The gate-itself entry ('') has no ungated equivalent — the
// shadow preamble already states its own :host background/color explicitly
// (see buildShadowStylesheet) — so a rule left with an empty selector list
// after dropping it is omitted entirely rather than emitted as invalid CSS.
export function buildUngatedBaseRules(): string {
  return BASE_RULES.flatMap((rule) => {
    const selectors = rule.selectors.filter((selector) => selector !== '');
    return selectors.length > 0 ? [formatRule(selectors, rule.declarations)] : [];
  }).join('\n\n');
}

export function buildOverrideRule(override: SiteOverride): string {
  return `html[data-pm-active="true"] ${override.selector} { ${override.property}: var(--pm-${tokenToCssVariableSuffix(override.token)}) !important; }`;
}
