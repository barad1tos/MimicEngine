import { buildSelectorHint } from '../engine/selectorHint';

export type ComputedBorderColorProperty =
  'borderTopColor' | 'borderRightColor' | 'borderBottomColor' | 'borderLeftColor';

export type ComputedColorSample = {
  selectorHint: string;
  property: 'color' | 'backgroundColor' | ComputedBorderColorProperty;
  value: string;
  tagName: string;
  textLength: number;
};

// A border side only renders when its computed width is positive; sampling
// an undrawn side would pollute the palette with the default currentColor.
const BORDER_SIDES: readonly {
  width: 'borderTopWidth' | 'borderRightWidth' | 'borderBottomWidth' | 'borderLeftWidth';
  color: ComputedBorderColorProperty;
}[] = [
  { width: 'borderTopWidth', color: 'borderTopColor' },
  { width: 'borderRightWidth', color: 'borderRightColor' },
  { width: 'borderBottomWidth', color: 'borderBottomColor' },
  { width: 'borderLeftWidth', color: 'borderLeftColor' },
];

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

    for (const property of sampledPropertiesFor(style)) {
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

function sampledPropertiesFor(style: CSSStyleDeclaration): ComputedColorSample['property'][] {
  const properties: ComputedColorSample['property'][] = ['color', 'backgroundColor'];
  for (const side of BORDER_SIDES) {
    if (Number.parseFloat(style[side.width]) > 0) properties.push(side.color);
  }
  return properties;
}

function isProbablyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
