import { STYLE_ELEMENT_ID } from '../injector/styleElement';

export type DomChangeObserver = {
  stop: () => void;
};

// Our own stylesheet write (injectStylesheet setting the style element's
// textContent) surfaces as a childList mutation whose target is that style
// element itself. A record is "ours" whenever its target IS that element or
// sits inside it. `styleElement` is looked up once per observer batch by the
// caller and passed in, rather than re-queried per record.
function isOwnStylesheetMutation(record: MutationRecord, styleElement: Element | null): boolean {
  if (!styleElement) return false;
  return styleElement === record.target || styleElement.contains(record.target);
}

export function observeDomChanges(callback: () => void, debounceMs = 250): DomChangeObserver {
  let timeoutId: number | undefined;

  const observer = new MutationObserver((records) => {
    const styleElement = document.getElementById(STYLE_ELEMENT_ID);
    // A batch made up entirely of our own stylesheet writes is not a page
    // change worth reacting to — skip scheduling so applying a theme never
    // re-triggers itself into a debounce loop.
    if (records.every((record) => isOwnStylesheetMutation(record, styleElement))) return;

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
