export type DomChangeObserver = {
  stop: () => void;
};

export function observeDomChanges(callback: () => void, debounceMs = 250): DomChangeObserver {
  let timeoutId: number | undefined;

  const observer = new MutationObserver(() => {
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
