import { buildSelectorHint } from '../engine/selectorHint';

export type ComputedColorSample = {
  selectorHint: string;
  property: 'color' | 'backgroundColor' | 'borderTopColor';
  value: string;
  tagName: string;
  textLength: number;
};

export type CollectComputedColorsOptions = {
  maxElements: number;
};

const DEFAULT_OPTIONS: CollectComputedColorsOptions = {
  maxElements: 1200,
};

export function collectComputedColors(
  root: ParentNode = document,
  options: Partial<CollectComputedColorsOptions> = {},
): ComputedColorSample[] {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const samples: ComputedColorSample[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  let visited = 0;
  while (walker.nextNode() && visited < resolvedOptions.maxElements) {
    visited += 1;
    const element = walker.currentNode;
    if (!(element instanceof HTMLElement)) continue;
    if (!isProbablyVisible(element)) continue;

    const style = getComputedStyle(element);
    const selectorHint = buildSelectorHint(element);

    for (const property of ['color', 'backgroundColor', 'borderTopColor'] as const) {
      const value = style[property];
      if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') continue;

      samples.push({
        selectorHint,
        property,
        value,
        tagName: element.tagName.toLowerCase(),
        textLength: element.innerText.length,
      });
    }
  }

  return samples;
}

function isProbablyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
