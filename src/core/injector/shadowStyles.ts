import { tokenToCssVariableSuffix } from '../engine/tokenVariables';
import { THEME_TOKEN_NAMES, type PaletteTheme } from '../themes';
import { buildUngatedBaseRules } from './buildBaseStylesheet';
import { STYLE_ELEMENT_ID } from './styleElement';

export const MAX_SHADOW_ROOTS = 32;

// TreeWalker over a Document only ever visits light-DOM elements — shadow
// trees are separate node trees the walker cannot enter, so "collect the
// open shadow roots we can see" and "never descend into them" are the same
// walk with no extra guard needed. Closed roots are invisible for the same
// reason .shadowRoot is null from the outside: nothing to special-case.
export function collectOpenShadowRoots(root: Document, maxRoots = MAX_SHADOW_ROOTS): ShadowRoot[] {
  const collected: ShadowRoot[] = [];
  const walker = root.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  for (
    let node = walker.nextNode();
    node !== null && collected.length < maxRoots;
    node = walker.nextNode()
  ) {
    if (node instanceof Element && node.shadowRoot !== null) {
      collected.push(node.shadowRoot);
    }
  }

  return collected;
}

function hostTokenDeclarations(theme: PaletteTheme): string {
  return THEME_TOKEN_NAMES.map(
    (tokenName) => `  --pm-${tokenToCssVariableSuffix(tokenName)}: ${theme.tokens[tokenName]};`,
  ).join('\n');
}

// The shadow-root reversibility carve-out: the document-level baseline gates
// every rule behind html[data-pm-active="true"], which can never match inside
// a shadow tree (it lives outside the tree entirely). Reversibility here is
// element removal instead — removeShadowStylesheets deletes our single style
// element from the root, same as the document flavor deletes its one style
// element and the data-pm-active attribute. The host itself is deliberately
// left transparent (not repainted to the canvas token) so a shadow-DOM widget
// keeps blending into whatever page background surrounds it; only its text
// color and custom properties are asserted directly, and buildUngatedBaseRules
// carries the rest of the floor unprefixed.
export function buildShadowStylesheet(theme: PaletteTheme): string {
  const hostBlock = [
    ':host {',
    hostTokenDeclarations(theme),
    '  color: var(--pm-text);',
    '  background-color: transparent;',
    '}',
  ].join('\n');

  return [hostBlock, buildUngatedBaseRules()].join('\n\n');
}

function createShadowStyleElement(css: string): HTMLStyleElement {
  const styleElement = document.createElement('style');
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.dataset.owner = 'palette-mimicry';
  styleElement.textContent = css;
  return styleElement;
}

// Same skip discipline as injectStylesheet (styleElement.ts): a same-content
// write must be a no-op, or a debounced mutation observer watching these
// shadow trees would re-trigger itself on our own childList mutation.
export function syncShadowStylesheets(css: string, roots: readonly ShadowRoot[]): void {
  for (const shadowRoot of roots) {
    const existing = shadowRoot.getElementById(STYLE_ELEMENT_ID);
    if (existing instanceof HTMLStyleElement) {
      if (existing.textContent !== css) {
        existing.textContent = css;
      }
      continue;
    }

    shadowRoot.append(createShadowStyleElement(css));
  }
}

// Used by both the disable path and a plan without deepRemap: a large cap
// (well beyond MAX_SHADOW_ROOTS) so every previously-styled root gets
// cleared, not just the ones a size-capped sync pass would have reached.
export function removeShadowStylesheets(root: Document): void {
  const roots = collectOpenShadowRoots(root, Number.POSITIVE_INFINITY);
  for (const shadowRoot of roots) {
    shadowRoot.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
}
