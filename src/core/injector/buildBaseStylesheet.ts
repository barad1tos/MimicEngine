import type { PaletteTheme } from '../themes';
import type { SiteOverride, ThemeMode } from '../storage/settingsStore';

export type BuildBaseStylesheetOptions = {
  mode: ThemeMode;
  preserveImages: boolean;
  preserveBrandColors: boolean;
  overrides: SiteOverride[];
};

export function buildBaseStylesheet(
  theme: PaletteTheme,
  options: BuildBaseStylesheetOptions,
): string {
  const { tokens } = theme;
  const preserveMedia = options.preserveImages
    ? `
html[data-pm-active="true"] img,
html[data-pm-active="true"] video,
html[data-pm-active="true"] canvas,
html[data-pm-active="true"] picture {
  filter: none !important;
}`
    : '';

  const overrideCss = options.overrides.map(buildOverrideRule).join('\n');

  return `
:root {
  --pm-canvas: ${tokens.canvas};
  --pm-surface1: ${tokens.surface1};
  --pm-surface2: ${tokens.surface2};
  --pm-surface3: ${tokens.surface3};
  --pm-text: ${tokens.text};
  --pm-text-muted: ${tokens.textMuted};
  --pm-border: ${tokens.border};
  --pm-accent: ${tokens.accent};
  --pm-link: ${tokens.link};
  --pm-success: ${tokens.success};
  --pm-warning: ${tokens.warning};
  --pm-danger: ${tokens.danger};
  --pm-selection: ${tokens.selection};
  --pm-focus: ${tokens.focus};
  color-scheme: ${theme.mode};
}

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

${preserveMedia}
${overrideCss}
`.trim();
}

function buildOverrideRule(override: SiteOverride): string {
  return `html[data-pm-active="true"] ${override.selector} { ${override.property}: var(--pm-${tokenToCssVariableSuffix(override.token)}) !important; }`;
}

function tokenToCssVariableSuffix(token: SiteOverride['token']): string {
  return token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
