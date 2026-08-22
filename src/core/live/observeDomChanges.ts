import { STYLE_ELEMENT_ID, TRANSITION_KILL_ELEMENT_ID } from '../injector/styleElement';

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
// the TRANSITION-KILL element — withStylesheetDisabled churns it through
// document.documentElement's childList (append, then remove) around every
// census read, which is neither a target match nor a page mutation. The
// exemption is deliberately THAT element only: the generated style element
// being removed is page activity (a sanitizer stripping it), and this
// debounced callback is the only path that recreates it — swallowing that
// record would leave the page unthemed until an unrelated mutation. Our own
// legitimate removal (the disabled-site path) never reaches here: the
// observer is disconnected in the same task, which discards the queued
// record. A record that mixes our churn with the page's own nodes is NOT
// ours: only the "target" branch above can classify those.
function isOwnStylesheetMutation(record: MutationRecord, styleElement: Element | null): boolean {
  if (styleElement && (styleElement === record.target || styleElement.contains(record.target))) {
    return true;
  }
  const churnedNodes = [...record.addedNodes, ...record.removedNodes];
  return (
    churnedNodes.length > 0 &&
    churnedNodes.every((node) => node instanceof Element && node.id === TRANSITION_KILL_ELEMENT_ID)
  );
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
