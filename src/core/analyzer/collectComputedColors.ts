import { buildSelectorHint } from '../engine/selectorHint';

export type ComputedBorderColorProperty =
  'borderTopColor' | 'borderRightColor' | 'borderBottomColor' | 'borderLeftColor';

export type ComputedColorSample = {
  selectorHint: string;
  // `borderColor` is the collapsed form: every drawn side shares one color,
  // so the element contributes a single border sample (weight 1 in the
  // palette's bucket majority) emitted as the `border-color` shorthand.
  property: 'color' | 'backgroundColor' | 'borderColor' | ComputedBorderColorProperty;
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

    for (const { property, value } of sampledDeclarationsFor(style)) {
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

type SampledDeclaration = { property: ComputedColorSample['property']; value: string };

// Border sides collapse by value: when every drawn side shares one color the
// element yields a single `borderColor` declaration, so a four-sided
// currentColor border weighs 1 (not 4) against the element's text sample in
// the palette's bucket majority. Sides with differing colors stay per-side.
function sampledDeclarationsFor(style: CSSStyleDeclaration): SampledDeclaration[] {
  const declarations: SampledDeclaration[] = [
    { property: 'color', value: style.color },
    { property: 'backgroundColor', value: style.backgroundColor },
  ];

  const drawnSides = BORDER_SIDES.filter((side) => Number.parseFloat(style[side.width]) > 0);
  const distinctValues = new Set(drawnSides.map((side) => style[side.color]));

  if (distinctValues.size === 1 && drawnSides[0]) {
    declarations.push({ property: 'borderColor', value: style[drawnSides[0].color] });
  } else {
    for (const side of drawnSides) {
      declarations.push({ property: side.color, value: style[side.color] });
    }
  }

  return declarations;
}

function isProbablyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
