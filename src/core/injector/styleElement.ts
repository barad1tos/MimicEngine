export const STYLE_ELEMENT_ID = 'palette-mimicry-generated-style';
export const TRANSITION_KILL_ELEMENT_ID = 'palette-mimicry-transition-kill';

// Exported so callers that need to enumerate our own ids (pageFacts.ts
// excluding our own stylesheets from the authored-CSS walk) don't duplicate
// this list — isOwnElement below covers the single-node membership check.
export const OWN_ELEMENT_IDS = new Set([STYLE_ELEMENT_ID, TRANSITION_KILL_ELEMENT_ID]);

// Shared by observeDomChanges' page-mutation debounce and
// pageThemeController's census observer: both must recognize the exact same
// set of elements as ours, since withStylesheetDisabled's transition-kill
// element churns document.documentElement's childList on every census chunk
// (signatureCensus.ts wraps its traversal in withStylesheetDisabled) — left
// unrecognized, that churn would re-trigger both observers, and in the
// census observer's case feed the kill element back into ingestAddedElements,
// which itself calls withStylesheetDisabled again, recursing without end.
// `id` is the established exclusion key elsewhere in this module; picking one
// mechanism (over dataset.owner, our other convention) and applying it
// consistently is what matters here.
export function isOwnElement(node: Node): boolean {
  return node instanceof Element && OWN_ELEMENT_IDS.has(node.id);
}

export function injectStylesheet(css: string): void {
  const styleElement = getOrCreateStyleElement();
  // Skipping identical writes keeps our own childList mutation out of the DOM
  // observer, so re-apply cycles terminate instead of looping every debounce.
  if (styleElement.textContent !== css) {
    styleElement.textContent = css;
  }
  document.documentElement.dataset.pmActive = 'true';
}

export function removeStylesheet(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  delete document.documentElement.dataset.pmActive;
}

// Sanctioned DOM read at produce time (computedFallback strategy): the caller
// samples getComputedStyle while our own injected rules are switched off, so
// the samples reflect the page's genuine styling rather than what we already
// wrote. Synchronous — no frame paints between the disable and the restore,
// so nothing else observes the page with our stylesheet off.
//
// A page-authored `transition` on the sampled property survives disabling our
// sheet: the browser keeps interpolating from our own last-painted value
// toward the newly-authored one, so a synchronous read inside this window can
// still see our output mid-transition (spec Amendment 3.8), poisoning
// re-census runs and flickering the surfaces whose reads flip between our
// value and the authored one. The kill element neutralizes every transition
// for the window's duration — including when our own style element doesn't
// exist, since an authored hover transition can be mid-flight on the page
// regardless of whether our sheet is present — and is always removed again
// before returning, even when fn throws.
export function withStylesheetDisabled<T>(fn: () => T): T {
  const killElement = createTransitionKillElement();
  document.documentElement.append(killElement);

  const styleElement = document.getElementById(STYLE_ELEMENT_ID);
  const ownStyleElement = styleElement instanceof HTMLStyleElement ? styleElement : null;
  if (ownStyleElement) ownStyleElement.disabled = true;

  try {
    return fn();
  } finally {
    if (ownStyleElement) ownStyleElement.disabled = false;
    killElement.remove();
  }
}

function createTransitionKillElement(): HTMLStyleElement {
  const element = document.createElement('style');
  element.id = TRANSITION_KILL_ELEMENT_ID;
  element.dataset.owner = 'palette-mimicry';
  element.textContent = '* { transition: none !important; }';
  return element;
}

function getOrCreateStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;

  const styleElement = document.createElement('style');
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.dataset.owner = 'palette-mimicry';
  document.documentElement.append(styleElement);
  return styleElement;
}
