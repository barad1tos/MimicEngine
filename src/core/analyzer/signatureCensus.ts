// src/core/analyzer/signatureCensus.ts
import { isOpaque, parseCssColor } from '../color/parseColor';
import { withStylesheetDisabled } from '../injector/styleElement';
import { computeSignature, signatureToSelector } from './styleSignature';

export const REPRESENTATIVES_PER_SIGNATURE = 3;

export type CensusColor = {
  cssProperty: string;
  bucket: 'text' | 'background' | 'border';
  value: string;
};

export type CensusSnapshot = {
  entries: { selector: string; colors: CensusColor[] }[];
  distinctColorsSeen: number;
  droppedProperties: number;
  signatureCount: number;
  elementsVisited: number;
  complete: boolean;
};

export type SignatureCensus = {
  begin(root: ParentNode): void;
  advance(maxElements: number): boolean;
  ingestAddedElements(elements: readonly Element[]): boolean;
  snapshot(): CensusSnapshot;
};

type SignatureRecord = {
  representativeCount: number;
  refined: boolean;
  // cssProperty -> { bucket, values seen across representatives }
  properties: Map<string, { bucket: CensusColor['bucket']; values: Set<string> }>;
};

const BORDER_SIDES = [
  { width: 'borderTopWidth', color: 'borderTopColor', cssProperty: 'border-top-color' },
  { width: 'borderRightWidth', color: 'borderRightColor', cssProperty: 'border-right-color' },
  { width: 'borderBottomWidth', color: 'borderBottomColor', cssProperty: 'border-bottom-color' },
  { width: 'borderLeftWidth', color: 'borderLeftColor', cssProperty: 'border-left-color' },
] as const;

export function createSignatureCensus(): SignatureCensus {
  const records = new Map<string, SignatureRecord>();
  const opaqueValuesSeen = new Set<string>();
  let droppedProperties = 0;
  let elementsVisited = 0;
  let walker: TreeWalker | null = null;
  let complete = false;

  function sampleInto(record: SignatureRecord, element: Element): void {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return;
    const style = getComputedStyle(element);

    for (const declaration of sampledDeclarationsFor(style)) {
      if (!isRelevantValue(declaration.value)) continue;
      trackOpaque(declaration.value);
      const slot = record.properties.get(declaration.cssProperty) ?? {
        bucket: declaration.bucket,
        values: new Set<string>(),
      };
      slot.values.add(declaration.value);
      record.properties.set(declaration.cssProperty, slot);
    }
    record.representativeCount += 1;
  }

  function trackOpaque(value: string): void {
    const color = parseCssColor(value);
    if (color && isOpaque(color)) opaqueValuesSeen.add(value);
  }

  function visit(element: Element): boolean {
    elementsVisited += 1;
    if (!isProbablyVisible(element)) return false;

    const signature = computeSignature(element);
    const existing = records.get(signature);
    if (existing) {
      if (existing.representativeCount < REPRESENTATIVES_PER_SIGNATURE)
        sampleInto(existing, element);
      return false;
    }
    const record: SignatureRecord = {
      representativeCount: 0,
      refined: false,
      properties: new Map(),
    };
    records.set(signature, record);
    sampleInto(record, element);
    return true;
  }

  function refineDivergentSignatures(): void {
    for (const record of records.values()) {
      for (const slot of record.properties.values()) {
        if (slot.values.size > 1) droppedProperties += 1;
      }
    }
  }

  function soleValue(values: Set<string>): string | null {
    if (values.size !== 1) return null;
    return values.values().next().value ?? null;
  }

  return {
    begin(root: ParentNode): void {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      complete = false;
    },

    advance(maxElements: number): boolean {
      if (!walker || complete) return true;
      const activeWalker = walker;
      const finished = withStylesheetDisabled((): boolean => {
        let stepped = 0;
        while (stepped < maxElements) {
          const node = activeWalker.nextNode();
          if (!node) return true;
          if (node instanceof Element) visit(node);
          stepped += 1;
        }
        return false;
      });
      if (finished) {
        complete = true;
        refineDivergentSignatures();
      }
      return complete;
    },

    ingestAddedElements(elements: readonly Element[]): boolean {
      let learned = false;
      withStylesheetDisabled(() => {
        for (const element of elements) {
          if (visit(element)) learned = true;
          for (const descendant of element.querySelectorAll('*')) {
            if (visit(descendant)) learned = true;
          }
        }
      });
      return learned;
    },

    snapshot(): CensusSnapshot {
      const entries: CensusSnapshot['entries'] = [];
      for (const [signature, record] of records) {
        const colors: CensusColor[] = [];
        for (const [cssProperty, slot] of record.properties) {
          const value = soleValue(slot.values);
          if (value !== null) colors.push({ cssProperty, bucket: slot.bucket, value });
        }
        entries.push({ selector: signatureToSelector(signature), colors });
      }
      return {
        entries,
        distinctColorsSeen: opaqueValuesSeen.size,
        droppedProperties,
        signatureCount: records.size,
        elementsVisited,
        complete,
      };
    },
  };
}

function isRelevantValue(value: string): boolean {
  return Boolean(value) && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

type SampledDeclaration = { cssProperty: string; bucket: CensusColor['bucket']; value: string };

// Moved from collectComputedColors (deleted in Task 4): uniform drawn border
// sides collapse to one border-color declaration (weight 1 in the palette's
// bucket majority — the Codex P1 fix from PR #11); differing sides stay
// per-side longhands. Sides gate on computed width > 0.
function sampledDeclarationsFor(style: CSSStyleDeclaration): SampledDeclaration[] {
  const declarations: SampledDeclaration[] = [
    { cssProperty: 'color', bucket: 'text', value: style.color },
    { cssProperty: 'background-color', bucket: 'background', value: style.backgroundColor },
  ];

  const drawnSides = BORDER_SIDES.filter((side) => Number.parseFloat(style[side.width]) > 0);
  const distinctValues = new Set(drawnSides.map((side) => style[side.color]));

  if (distinctValues.size === 1 && drawnSides[0]) {
    declarations.push({
      cssProperty: 'border-color',
      bucket: 'border',
      value: style[drawnSides[0].color],
    });
  } else {
    for (const side of drawnSides) {
      declarations.push({
        cssProperty: side.cssProperty,
        bucket: 'border',
        value: style[side.color],
      });
    }
  }

  return declarations;
}

function isProbablyVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
