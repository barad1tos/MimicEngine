import { STYLE_ELEMENT_ID } from '../injector/styleElement';

export type DomChangeObserver = {
  stop: () => void;
};

// Our own stylesheet write (injectStylesheet setting the style element's
// textContent) surfaces as a childList mutation whose target is that style
// element itself. A record is "ours" whenever its target IS that element or
// sits inside it.
function isOwnStylesheetMutation(record: MutationRecord): boolean {
  const styleElement = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleElement) return false;
  return styleElement === record.target || styleElement.contains(record.target);
}

export function observeDomChanges(callback: () => void, debounceMs = 250): DomChangeObserver {
  let timeoutId: number | undefined;

  const observer = new MutationObserver((records) => {
    // A batch made up entirely of our own stylesheet writes is not a page
    // change worth reacting to — skip scheduling so applying a theme never
    // re-triggers itself into a debounce loop.
    if (records.every(isOwnStylesheetMutation)) return;

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      callback();
    }, debounceMs);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'aria-hidden'],
  });

  return {
    stop() {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      observer.disconnect();
    },
  };
}
