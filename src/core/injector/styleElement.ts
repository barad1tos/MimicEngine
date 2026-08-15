const STYLE_ELEMENT_ID = 'palette-mimicry-generated-style';

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

function getOrCreateStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;

  const styleElement = document.createElement('style');
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.dataset.owner = 'palette-mimicry';
  document.documentElement.append(styleElement);
  return styleElement;
}
