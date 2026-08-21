// src/core/analyzer/signatureCensus.ts
import { isOpaque, parseCssColor } from '../color/parseColor';
import { withStylesheetDisabled } from '../injector/styleElement';
import { computeRefinedSignature, computeSignature, signatureToSelector } from './styleSignature';

export const REPRESENTATIVES_PER_SIGNATURE = 3;

export type CensusColor = {
  cssProperty: string;
  bucket: 'text' | 'background' | 'border';
  value: string;
};

export type CensusSnapshot = {
  entries: { selector: string; colors: CensusColor[] }[];
  distinctColorsSeen: number;
  // Every opaque value the census has sampled, in insertion (first-seen)
  // order — the raw material computedFallback's coverage denominator parses
  // and hex-dedupes itself, kept separate from distinctColorsSeen (a count)
  // so a strategy can exclude authored-covered colors from its own tally
  // without the census needing to know about authoredRemap at all.
  opaqueValuesSeen: readonly string[];
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
  // Raw signatures refineDivergentSignatures() has deleted in favor of
  // parent-qualified refined records. A later visit() (ingestAddedElements,
  // typically) that recomputes one of these raw keys must key by refined
  // context instead — the raw record is gone for good, not merely stale, so
  // creating a fresh raw record would re-introduce the exact ambiguity
  // refinement just resolved (see C-1: an unrefined `:where(button.btn)`
  // rule landing after the refined rules and overriding both by source
  // order).
  const refinedAway = new Set<string>();
  let droppedProperties = 0;
  let elementsVisited = 0;
  let walker: TreeWalker | null = null;
  let complete = false;

  // Returns true when this pass added at least one distinct value to any
  // property's values Set — i.e. genuinely new information, not just another
  // representative confirming what was already known. A signature already at
  // the representative cap, or a twin whose colors all match prior samples,
  // must not be reported as "learned" by callers keying off this.
  function sampleInto(record: SignatureRecord, element: Element): boolean {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
    const style = getComputedStyle(element);
    let sampledNewValue = false;

    for (const declaration of sampledDeclarationsFor(style)) {
      if (!isRelevantValue(declaration.value)) continue;
      trackOpaque(declaration.value);
      const slot = record.properties.get(declaration.cssProperty) ?? {
        bucket: declaration.bucket,
        values: new Set<string>(),
      };
      if (!slot.values.has(declaration.value)) {
        slot.values.add(declaration.value);
        sampledNewValue = true;
      }
      record.properties.set(declaration.cssProperty, slot);
    }
    record.representativeCount += 1;
    return sampledNewValue;
  }

  function trackOpaque(value: string): void {
    const color = parseCssColor(value);
    if (color && isOpaque(color)) opaqueValuesSeen.add(value);
  }

  function visit(element: Element): boolean {
    elementsVisited += 1;
    if (!isProbablyVisible(element)) return false;

    const rawSignature = computeSignature(element);
    // A raw signature refinement already split away must never be reborn as
    // a fresh unrefined record — key this element by the same depth-1
    // parent context refineDivergentSignatures used, so it either joins the
    // existing refined record for that context or starts a new one, exactly
    // as if this element had been present during the original refinement.
    const isRefinedAway = refinedAway.has(rawSignature);
    const signature = isRefinedAway ? computeRefinedSignature(element) : rawSignature;
    const existing = records.get(signature);
    if (existing) {
      if (existing.representativeCount >= REPRESENTATIVES_PER_SIGNATURE) return false;
      return sampleInto(existing, element);
    }
    const record: SignatureRecord = {
      representativeCount: 0,
      refined: isRefinedAway,
      properties: new Map(),
    };
    records.set(signature, record);
    sampleInto(record, element);
    return true;
  }

  // Depth-1 refinement, run once per census at traversal completion (and
  // after each ingestAddedElements batch that learned something): a
  // signature whose representatives disagreed on any property is re-keyed
  // by parent context. Occurrences are re-found with a fresh DOM query — no
  // element references are ever retained. If a refined record still
  // disagrees, the property is dropped and counted; refined records are
  // never refined again (depth cap).
  function refineDivergentSignatures(): void {
    for (const [signature, record] of [...records.entries()]) {
      if (record.refined) continue;
      const divergent = [...record.properties.values()].some((slot) => slot.values.size > 1);
      if (!divergent) continue;

      records.delete(signature);
      refinedAway.add(signature);
      const occurrences = findOccurrences(signature);
      withStylesheetDisabled(() => {
        for (const element of occurrences) {
          const refinedKey = computeRefinedSignature(element);
          const refinedRecord = records.get(refinedKey) ?? {
            representativeCount: 0,
            refined: true,
            properties: new Map(),
          };
          records.set(refinedKey, refinedRecord);
          if (refinedRecord.representativeCount < REPRESENTATIVES_PER_SIGNATURE) {
            sampleInto(refinedRecord, element);
          }
        }
      });
    }

    for (const record of records.values()) {
      for (const [cssProperty, slot] of record.properties) {
        if (slot.values.size > 1) {
          record.properties.delete(cssProperty);
          droppedProperties += 1;
        }
      }
    }
  }

  function findOccurrences(signature: string): Element[] {
    const candidates = document.querySelectorAll(signatureToSelector(signature));
    return [...candidates].filter((element) => computeSignature(element) === signature);
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
        // Drop the retained TreeWalker once traversal is done: it pins its
        // root and every node visited to reach the end, which — if kept
        // alive past this point (e.g. across a same-page SPA navigation) —
        // would hold pre-navigation DOM in memory for no further benefit.
        walker = null;
        refineDivergentSignatures();
      }
      return complete;
    },

    ingestAddedElements(elements: readonly Element[]): boolean {
      const learned = withStylesheetDisabled((): boolean => {
        let learnedAny = false;
        for (const element of elements) {
          if (visit(element)) learnedAny = true;
          for (const descendant of element.querySelectorAll('*')) {
            if (visit(descendant)) learnedAny = true;
          }
        }
        return learnedAny;
      });
      if (learned && complete) refineDivergentSignatures();
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
        opaqueValuesSeen: [...opaqueValuesSeen],
        droppedProperties,
        signatureCount: records.size,
        elementsVisited,
        complete,
      };
    },
  };
}

let installed: SignatureCensus | null = null;

// The controller installs its live census on start() and clears it on
// stop(); computedFallback.produce reads whatever is installed. No census
// (unit tests, non-page contexts) reads as null — the strategy emits
// nothing, same as an empty-sample page.
export function installCensus(census: SignatureCensus | null): void {
  installed = census;
}

export function installedCensus(): SignatureCensus | null {
  return installed;
}

function isRelevantValue(value: string): boolean {
  return Boolean(value) && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

type SampledDeclaration = { cssProperty: string; bucket: CensusColor['bucket']; value: string };

// Moved from computedFallback's legacy per-produce() DOM sampler, deleted
// once the census became the single sampling pass: uniform drawn border
// sides collapse to one border-color declaration
// (weight 1 in the palette's bucket majority — the Codex P1 fix from PR #11);
// differing sides stay per-side longhands. Sides gate on computed width > 0.
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
