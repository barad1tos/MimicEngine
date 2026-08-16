import { tokenToCssVariableSuffix } from '../engine/tokenVariables';
import { THEME_TOKEN_NAMES, type PaletteTheme } from '../themes';
import { buildUngatedBaseRules } from './buildBaseStylesheet';
import { STYLE_ELEMENT_ID } from './styleElement';

export const MAX_SHADOW_ROOTS = 32;

// Cumulative record of every shadow root we've styled, kept across sync
// calls so removeShadowStylesheets can reach a host that got detached
// between a sync and the removal — the document walk collectOpenShadowRoots
// runs can only see roots still attached under the document, so a detached
// host is invisible to it and the walk alone would miss the root, leave our
// style element behind, and resurrect it ungated on re-attach. WeakRef so a
// host removed for good doesn't keep its ShadowRoot pinned in memory forever.
const styledRoots = new Set<WeakRef<ShadowRoot>>();

function isRootTracked(shadowRoot: ShadowRoot): boolean {
  for (const ref of styledRoots) {
    if (ref.deref() === shadowRoot) return true;
  }
  return false;
}

// Dedupes by identity (not Set membership, which WeakRef wrappers defeat)
// so re-syncing the same roots on every debounced re-apply doesn't grow this
// set without bound over a long-lived page.
function trackStyledRoot(shadowRoot: ShadowRoot): void {
  if (isRootTracked(shadowRoot)) return;
  styledRoots.add(new WeakRef(shadowRoot));
}

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

// Created from the root's own document, not the global `document` — a
// shadow root can belong to a document other than the one this module was
// evaluated in (e.g. an <iframe>'s content document), and a node's owner
// document must match the tree it gets appended into.
function createShadowStyleElement(ownerDocument: Document, css: string): HTMLStyleElement {
  const styleElement = ownerDocument.createElement('style');
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
    trackStyledRoot(shadowRoot);
    const existing = shadowRoot.getElementById(STYLE_ELEMENT_ID);
    if (existing instanceof HTMLStyleElement) {
      if (existing.textContent !== css) {
        existing.textContent = css;
      }
      continue;
    }

    shadowRoot.append(createShadowStyleElement(shadowRoot.ownerDocument, css));
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

  // Belt-and-braces: the document walk above only reaches roots still
  // attached under `root`. A host detached since its last sync is invisible
  // to that walk, so tracked roots are swept independently — this is the
  // only path that reaches a styled-then-detached host. Also covers roots
  // styled by a previous controller instance in the same document, since
  // this tracking is module-level, not per-controller.
  for (const ref of styledRoots) {
    ref.deref()?.getElementById(STYLE_ELEMENT_ID)?.remove();
  }
  styledRoots.clear();
}
