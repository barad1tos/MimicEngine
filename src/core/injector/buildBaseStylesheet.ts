import type { PaletteTheme } from '../themes';
import type { SiteOverride } from '../storage/settingsStore';
import { tokenToCssVariableSuffix } from '../engine/tokenVariables';

export function buildBaseStylesheet(_theme: PaletteTheme): string {
  return `
html[data-pm-active="true"],
html[data-pm-active="true"] body {
  background-color: var(--pm-canvas) !important;
  color: var(--pm-text) !important;
}

html[data-pm-active="true"] body,
html[data-pm-active="true"] main,
html[data-pm-active="true"] article,
html[data-pm-active="true"] section,
html[data-pm-active="true"] aside,
html[data-pm-active="true"] nav,
html[data-pm-active="true"] header,
html[data-pm-active="true"] footer {
  border-color: var(--pm-border) !important;
}

html[data-pm-active="true"] :where(p, span, li, dt, dd, label, summary, small, strong, em, h1, h2, h3, h4, h5, h6) {
  color: inherit;
}

html[data-pm-active="true"] :where(a, a:visited) {
  color: var(--pm-link) !important;
}

html[data-pm-active="true"] :where(button, [role="button"], input, select, textarea) {
  background-color: var(--pm-surface1) !important;
  color: var(--pm-text) !important;
  border-color: var(--pm-border) !important;
  caret-color: var(--pm-accent) !important;
}

html[data-pm-active="true"] :where(button:hover, [role="button"]:hover, input:hover, select:hover, textarea:hover) {
  background-color: var(--pm-surface2) !important;
}

html[data-pm-active="true"] :where(button:focus-visible, [role="button"]:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible) {
  outline: 2px solid var(--pm-focus) !important;
  outline-offset: 2px !important;
}

html[data-pm-active="true"] :where(code, kbd, samp, pre) {
  background-color: var(--pm-surface1) !important;
  color: var(--pm-text) !important;
  border-color: var(--pm-border) !important;
}

html[data-pm-active="true"] :where(table, thead, tbody, tr, td, th) {
  border-color: var(--pm-border) !important;
}

html[data-pm-active="true"] :where(th) {
  background-color: var(--pm-surface1) !important;
  color: var(--pm-text) !important;
}

html[data-pm-active="true"] :where(blockquote, details, dialog, fieldset, figure, form) {
  background-color: var(--pm-surface1) !important;
  color: var(--pm-text) !important;
  border-color: var(--pm-border) !important;
}

html[data-pm-active="true"] ::selection {
  background-color: var(--pm-selection) !important;
  color: var(--pm-text) !important;
}
`.trim();
}

export function buildOverrideRule(override: SiteOverride): string {
  return `html[data-pm-active="true"] ${override.selector} { ${override.property}: var(--pm-${tokenToCssVariableSuffix(override.token)}) !important; }`;
}
