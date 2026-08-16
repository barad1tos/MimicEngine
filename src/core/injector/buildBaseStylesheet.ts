import type { PaletteTheme } from '../themes';
import type { SiteOverride } from '../storage/settingsStore';
import { tokenToCssVariableSuffix } from '../engine/tokenVariables';

const ACTIVE_GATE = 'html[data-pm-active="true"]';

// One rule's selectors, expressed relative to the active-document gate: ''
// means "the gated element itself" (only meaningful in the gated flavor —
// buildUngatedBaseRules drops it, see there for why), anything else is a
// descendant selector appended after the gate with a separating space.
type GatedRule = {
  readonly selectors: readonly string[];
  readonly declarations: readonly string[];
};

const BASE_RULES: readonly GatedRule[] = [
  {
    selectors: ['', 'body'],
    declarations: [
      'background-color: var(--pm-canvas) !important;',
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
    selectors: [':where(button, [role="button"], input, select, textarea)'],
    declarations: [
      'background-color: var(--pm-surface1) !important;',
      'color: var(--pm-text) !important;',
      'border-color: var(--pm-border) !important;',
      'caret-color: var(--pm-accent) !important;',
    ],
  },
  {
    selectors: [
      ':where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover)',
    ],
    declarations: ['background-color: var(--pm-surface2) !important;'],
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
      'background-color: var(--pm-surface1) !important;',
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
      'background-color: var(--pm-surface1) !important;',
      'color: var(--pm-text) !important;',
    ],
  },
  {
    selectors: [':where(blockquote, details, dialog, fieldset, figure, form)'],
    declarations: [
      'background-color: var(--pm-surface1) !important;',
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

export function buildBaseStylesheet(_theme: PaletteTheme): string {
  return BASE_RULES.map((rule) =>
    formatRule(
      rule.selectors.map((selector) =>
        selector === '' ? ACTIVE_GATE : `${ACTIVE_GATE} ${selector}`,
      ),
      rule.declarations,
    ),
  ).join('\n\n');
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
