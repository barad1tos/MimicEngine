/**
 * Builds a short, human-readable selector hint for an element: its id if
 * present, else its tag name plus up to its first two classes. Not a full
 * CSS selector — just enough to identify the declaration's origin in facts
 * and diagnostics.
 */
export function buildSelectorHint(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const className = [...element.classList]
    .slice(0, 2)
    .map((item) => `.${CSS.escape(item)}`)
    .join('');
  return `${element.tagName.toLowerCase()}${className}`;
}
