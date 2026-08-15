export const STYLE_ELEMENT_ID = 'palette-mimicry-generated-style';

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
export function withStylesheetDisabled<T>(fn: () => T): T {
  const element = document.getElementById(STYLE_ELEMENT_ID);
  if (!(element instanceof HTMLStyleElement)) return fn();

  element.disabled = true;
  try {
    return fn();
  } finally {
    element.disabled = false;
  }
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
