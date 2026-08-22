import { isOwnElement, STYLE_ELEMENT_ID } from '../injector/styleElement';

export type DomChangeObserver = {
  stop: () => void;
};

// Shared with the census's own mutation observer (pageThemeController.ts):
// both must react to exactly the same attribute mutations, since a
// class/style/data-theme/aria-hidden flip is the one kind of change that can
// alter computed colors without touching childList at all.
export const SIGNIFICANT_ATTRIBUTES = ['class', 'style', 'data-theme', 'aria-hidden'] as const;

// Our own stylesheet write (injectStylesheet setting the style element's
// textContent) surfaces as a childList mutation whose target is that style
// element itself; a record is "ours" whenever its target IS that element or
// sits inside it. `styleElement` is looked up once per observer batch by the
// caller and passed in, rather than re-queried per record.
//
// A record is also "ours" when every one of its added and removed nodes is
// one of our own elements (isOwnElement) — withStylesheetDisabled's
// transition-kill element churns document.documentElement's own childList
// (append, then remove) around every census read, which is neither a target
// match nor a page mutation. A record that mixes our nodes with the page's
// own is NOT ours: only the "target" branch above can classify those.
function isOwnStylesheetMutation(record: MutationRecord, styleElement: Element | null): boolean {
  if (styleElement && (styleElement === record.target || styleElement.contains(record.target))) {
    return true;
  }
  const churnedNodes = [...record.addedNodes, ...record.removedNodes];
  return churnedNodes.length > 0 && churnedNodes.every(isOwnElement);
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
    attributeFilter: [...SIGNIFICANT_ATTRIBUTES],
  });

  return {
    stop() {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      observer.disconnect();
    },
  };
}
