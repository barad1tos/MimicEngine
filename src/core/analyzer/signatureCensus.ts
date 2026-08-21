// src/core/analyzer/signatureCensus.ts
import { isOpaque, parseCssColor } from '../color/parseColor';
import { withStylesheetDisabled } from '../injector/styleElement';
import { computeRefinedSignature, computeSignature, signatureToSelector } from './styleSignature';

export const REPRESENTATIVES_PER_SIGNATURE = 3;

export type CensusColor = {
  cssProperty: string;
  bucket: 'text' | 'background' | 'border';
  value: string;
  elevation?: number;
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
  // cssProperty -> { bucket, values AND elevations seen across
  // representatives }. `elevations` is only ever populated on the
  // background slot (elevationOf is meaningless for text/border) and, like
  // `values`, is insertion-ordered — its first entry is the FIRST elevation
  // any representative landed for this property, the "first-wins" value
  // snapshot() exposes as the property's single `elevation`. Two
  // representatives disagreeing on elevation (same background hex, but one
  // sits deeper in an opaque-ancestor stack than the other — see C-3) is
  // divergence exactly like disagreeing on `values`: refineDivergentSignatures
  // re-keys by parent context so each stacking depth gets its own record
  // instead of silently collapsing onto whichever depth was sampled first.
  properties: Map<
    string,
    { bucket: CensusColor['bucket']; values: Set<string>; elevations: Set<number> }
  >;
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

  const trackOpaque = (value: string): void => {
    const color = parseCssColor(value);
    if (color && isOpaque(color)) opaqueValuesSeen.add(value);
  };

  // Returns true when this pass added at least one distinct value to any
  // property's values Set — i.e. genuinely new information, not just another
  // representative confirming what was already known. A signature already at
  // the representative cap, or a twin whose colors all match prior samples,
  // must not be reported as "learned" by callers keying off this.
  const sampleInto = (record: SignatureRecord, element: Element): boolean => {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
    const style = getComputedStyle(element);
    let sampledNewValue = false;

    for (const declaration of sampledDeclarationsFor(style)) {
      if (!isRelevantValue(declaration.value)) continue;
      trackOpaque(declaration.value);
      const existingSlot = record.properties.get(declaration.cssProperty);
      const slot = existingSlot ?? {
        bucket: declaration.bucket,
        values: new Set<string>(),
        elevations: new Set<number>(),
      };
      if (!slot.values.has(declaration.value)) {
        slot.values.add(declaration.value);
        sampledNewValue = true;
      }
      // Elevation is expensive (walks the ancestor chain), so it's computed
      // lazily, right here, only for a background declaration that just
      // survived the relevance filter above — but on EVERY representative,
      // not just the first: two representatives can share the same
      // background hex while sitting at different stacking depths (C-3), and
      // that disagreement is only visible if every representative's own
      // elevation gets recorded, not just the first one's.
      if (declaration.bucket === 'background') {
        const elevation = elevationOf(element);
        if (!slot.elevations.has(elevation)) {
          slot.elevations.add(elevation);
          sampledNewValue = true;
        }
      }
      record.properties.set(declaration.cssProperty, slot);
    }
    record.representativeCount += 1;
    return sampledNewValue;
  };

  const visit = (element: Element): boolean => {
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
  };

  // Depth-1 refinement, run once per census at traversal completion (and
  // after each ingestAddedElements batch that learned something): a
  // signature whose representatives disagreed on any property's VALUE, or
  // (background slots only) on its ELEVATION, is re-keyed by parent context
  // — same background hex at two different stacking depths is still a real
  // split, just a gentler one than a color mismatch (C-3). Occurrences are
  // re-found with a fresh DOM query — no element references are ever
  // retained. If a refined record still disagrees on VALUE, the property is
  // dropped and counted; elevation disagreement never drops the property
  // (see the drop loop below) — it degrades to first-wins instead, since an
  // approximate stacking depth is still useful signal, unlike a wrong color.
  // Refined records are never refined again (depth cap).
  const refineDivergentSignatures = (): void => {
    // Iterates the Map live (not a snapshot copy): deleting the entry the
    // loop is currently on is spec-defined-safe for Map iteration, and any
    // refined record this same pass inserts is visited later in the same
    // loop but immediately skipped by the `record.refined` check below — a
    // live iteration never re-processes what it just created.
    for (const [signature, record] of records) {
      if (record.refined) continue;
      const divergent = [...record.properties.values()].some(
        (slot) => slot.values.size > 1 || slot.elevations.size > 1,
      );
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
  };

  const soleValue = (values: Set<string>): string | null => {
    if (values.size !== 1) return null;
    return values.values().next().value ?? null;
  };

  // Unlike soleValue, this never rejects on size > 1: an elevation slot that
  // is STILL mixed after refinement (the depth-1 cap left two stacking
  // depths sharing one record) degrades gracefully to first-wins rather than
  // dropping the property outright (C-3) — `elevations` is insertion-ordered,
  // so its first entry is exactly the first representative's own reading.
  const firstElevation = (elevations: Set<number>): number | undefined => {
    const first = elevations.values().next();
    return first.done ? undefined : first.value;
  };

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
          if (value === null) continue;
          const elevation = firstElevation(slot.elevations);
          colors.push({
            cssProperty,
            bucket: slot.bucket,
            value,
            ...(elevation === undefined ? {} : { elevation }),
          });
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

// Only touches document + module-level imports (signatureToSelector,
// computeSignature) — no closure-captured state, so it lives at module
// scope rather than inside createSignatureCensus().
function findOccurrences(signature: string): Element[] {
  const candidates = document.querySelectorAll(signatureToSelector(signature));
  return [...candidates].filter((element) => computeSignature(element) === signature);
}

function isRelevantValue(value: string): boolean {
  return Boolean(value) && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

type SampledDeclaration = {
  cssProperty: string;
  bucket: CensusColor['bucket'];
  value: string;
  elevation?: number;
};

// Moved from computedFallback's legacy per-produce() DOM sampler, deleted
// once the census became the single sampling pass: uniform drawn border
// sides collapse to one border-color declaration
// (weight 1 in the palette's bucket majority — the Codex P1 fix from PR #11);
// differing sides stay per-side longhand declarations. Sides gate on
// computed width > 0.
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

// Count of ancestors with an opaque computed background — the "stacking
// depth" a background color sits at. Called only from inside the
// withStylesheetDisabled window sampleInto already runs in, so these
// getComputedStyle reads see the page's authored colors, not ours.
function elevationOf(element: Element): number {
  let count = 0;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const background = parseCssColor(getComputedStyle(ancestor).backgroundColor);
    if (background && isOpaque(background)) count += 1;
  }
  return count;
}
