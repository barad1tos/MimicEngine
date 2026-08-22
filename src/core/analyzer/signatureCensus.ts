// src/core/analyzer/signatureCensus.ts
import { type HexColor, isOpaque, parseCssColor, parseRgbColor, toHex } from '../color/parseColor';
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
  // `signature` is the raw census key the selector was derived from —
  // emitted selectors are CSS-escaped and unsafe to parse back, so
  // signature-level math (computedFallback's superset-bleed neutralizer)
  // reads this field, never the selector.
  entries: { signature: string; selector: string; colors: CensusColor[] }[];
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
  // snapshot() exposes as the property's single `elevation`. Elevation is
  // BINARY (Amendment 3.7): 1 = island (the element itself starts a
  // surface), 0 = surface-following. Two representatives disagreeing on it
  // (same background hex, but one is an island in its context and the
  // other surface-following — see C-3) is divergence exactly like
  // disagreeing on `values`: refineDivergentSignatures re-keys by parent
  // context so each classification gets its own record instead of silently
  // collapsing onto whichever was sampled first.
  // `hasOpaqueValue`/`hasTransparentRepresentative` are background-only
  // (Amendment 3.3): a representative whose OWN background is explicitly
  // `transparent`/`rgba(0, 0, 0, 0)` never enters `values` (that would
  // corrupt color logic downstream), but its presence must still be visible
  // to divergence — otherwise state-differing siblings sharing one signature
  // (an active vs. inactive filter pill) collapse onto whichever
  // representative happened to be opaque, flakily across loads (K-rep order).
  properties: Map<string, PropertySlot>;
  // cssProperty names refineDivergentSignatures() has DROPPED for THIS
  // record (Codex census, PR #18 — resurrection fix): deleting a slot from
  // `properties` alone erases only the current sample, not the fact that a
  // conflict was ever seen. Without a tombstone, a record still under the
  // K=3 cap (or an already-`refined` record: refinement never revisits it,
  // so nothing else would ever re-detect the conflict) that gains one more
  // representative via ingestAddedElements would recreate a fresh,
  // single-value slot — silently resurrecting the exact painted-wrong-color
  // bug the drop existed to prevent. `sampleInto` checks this set and
  // refuses to record into a tombstoned property at all, so a dropped
  // property can never come back for this record's lifetime. Named
  // `tombstonedProperties` (not `droppedProperties`, matching Codex's
  // report) specifically so it never collides with the census-level
  // `droppedProperties` COUNT this module already tracks.
  tombstonedProperties: Set<string>;
};

type PropertySlot = {
  bucket: CensusColor['bucket'];
  values: Set<string>;
  elevations: Set<number>;
  hasOpaqueValue: boolean;
  hasTransparentRepresentative: boolean;
};

const BORDER_SIDES = [
  {
    width: 'borderTopWidth',
    borderStyle: 'borderTopStyle',
    color: 'borderTopColor',
    cssProperty: 'border-top-color',
  },
  {
    width: 'borderRightWidth',
    borderStyle: 'borderRightStyle',
    color: 'borderRightColor',
    cssProperty: 'border-right-color',
  },
  {
    width: 'borderBottomWidth',
    borderStyle: 'borderBottomStyle',
    color: 'borderBottomColor',
    cssProperty: 'border-bottom-color',
  },
  {
    width: 'borderLeftWidth',
    borderStyle: 'borderLeftStyle',
    color: 'borderLeftColor',
    cssProperty: 'border-left-color',
  },
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

  // A background declaration that is EXPLICITLY transparent (the literal
  // keyword or the zero-alpha rgba form) never joins `values` — that would
  // hand a transparent slot a "color" to paint, corrupting every downstream
  // color-mapping step. But its presence must still register:
  // `hasTransparentRepresentative` is the only signal the divergence check
  // has that this signature isn't uniformly opaque (Amendment 3.3). Returns
  // whether this is the first transparent representative this slot has seen.
  const recordTransparentBackground = (record: SignatureRecord, cssProperty: string): boolean => {
    const existingSlot = record.properties.get(cssProperty);
    const slot = existingSlot ?? emptyPropertySlot('background');
    const isNewSignal = !slot.hasTransparentRepresentative;
    slot.hasTransparentRepresentative = true;
    record.properties.set(cssProperty, slot);
    return isNewSignal;
  };

  // Island classification is expensive (walks up to the nearest opaque
  // ancestor), so it's computed lazily, only for a background declaration
  // that just survived the relevance filter — but on EVERY representative,
  // not just the first: two representatives can share the same background
  // hex while one is an island in its context and the other
  // surface-following (C-3), and that disagreement is only visible if every
  // representative's own classification gets recorded. `hasOpaqueValue`
  // is the other half of the Amendment 3.3 divergence signal, alongside
  // `hasTransparentRepresentative` above. Returns whether either reading was
  // genuinely new information.
  const recordBackgroundExtras = (slot: PropertySlot, value: string, element: Element): boolean => {
    const elevation = elevationOf(element);
    const learnedElevation = !slot.elevations.has(elevation);
    if (learnedElevation) slot.elevations.add(elevation);

    const color = parseCssColor(value);
    if (color && isOpaque(color)) slot.hasOpaqueValue = true;

    return learnedElevation;
  };

  const recordRelevantValue = (
    record: SignatureRecord,
    declaration: SampledDeclaration,
    element: Element,
  ): boolean => {
    trackOpaque(declaration.value);
    const existingSlot = record.properties.get(declaration.cssProperty);
    const slot = existingSlot ?? emptyPropertySlot(declaration.bucket);
    let learnedSomething = false;

    if (!slot.values.has(declaration.value)) {
      slot.values.add(declaration.value);
      learnedSomething = true;
    }
    if (
      declaration.bucket === 'background' &&
      recordBackgroundExtras(slot, declaration.value, element)
    ) {
      learnedSomething = true;
    }
    record.properties.set(declaration.cssProperty, slot);
    return learnedSomething;
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
      // A tombstoned property never gets a slot again for this record — no
      // recreation, no flag churn, no risk of a later representative
      // resurrecting a conflict this record already retreated from honestly.
      if (record.tombstonedProperties.has(declaration.cssProperty)) continue;

      if (declaration.bucket === 'background' && isTransparentValue(declaration.value)) {
        if (recordTransparentBackground(record, declaration.cssProperty)) sampledNewValue = true;
        continue;
      }
      if (!isRelevantValue(declaration.value)) continue;
      if (recordRelevantValue(record, declaration, element)) sampledNewValue = true;
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
      tombstonedProperties: new Set(),
    };
    records.set(signature, record);
    sampleInto(record, element);
    return true;
  };

  // Depth-1 refinement, run once per census at traversal completion (and
  // after each ingestAddedElements batch that learned something): a
  // signature whose representatives disagreed on any property's VALUE, on
  // its ELEVATION (background slots only), or MIXED an opaque background
  // with an explicitly transparent one (Amendment 3.3 — same-signature
  // siblings differing only by state, e.g. active vs. inactive filter
  // pills), is re-keyed by parent context. Occurrences are re-found with a
  // fresh DOM query — no element references are ever retained. If a refined
  // record still disagrees on VALUE, or is still an opaque/transparent mix,
  // the property is dropped and counted; elevation disagreement alone never
  // drops the property (see the drop loop below) — it degrades to
  // first-wins instead, since an approximate island classification is still
  // useful signal, unlike a wrong color or a guessed-opaque transparent
  // element. Refined records are never refined again (depth cap).
  // A signature is divergent when its representatives disagree on any
  // property's VALUE, on its ELEVATION (background slots only), or MIXED an
  // opaque background with an explicitly transparent one (Amendment 3.3).
  const isDivergentSlot = (slot: PropertySlot): boolean =>
    slot.values.size > 1 ||
    slot.elevations.size > 1 ||
    (slot.hasOpaqueValue && slot.hasTransparentRepresentative);

  // The narrower subset of `isDivergentSlot` that actually DROPS a property
  // (see dropDivergentProperties): elevation-only disagreement is excluded
  // on purpose — it degrades to first-wins (see firstElevation below), not a
  // drop. Any slot this returns true for was necessarily already caught by
  // isDivergentSlot in an earlier pass, so a raw (non-refined) record can
  // never reach this check without having gone through refineSignature
  // first — see the resurrection-guard trace in the type comment above.
  const isDropWorthySlot = (slot: PropertySlot): boolean =>
    slot.values.size > 1 || (slot.hasOpaqueValue && slot.hasTransparentRepresentative);

  // Re-keys one divergent raw signature by one level of parent context and
  // re-samples occurrences fresh via a new DOM query — no element
  // references are ever retained, and the resulting refined record(s)
  // inherit NOTHING from the raw record (own empty `properties` and
  // `tombstonedProperties`; see the type comment above).
  const refineSignature = (signature: string): void => {
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
          tombstonedProperties: new Set(),
        };
        records.set(refinedKey, refinedRecord);
        if (refinedRecord.representativeCount < REPRESENTATIVES_PER_SIGNATURE) {
          sampleInto(refinedRecord, element);
        }
      }
    });
  };

  // Deletes and tombstones every still drop-worthy property on `record` —
  // an honest retreat, never a guessed-opaque paint. Tombstoning happens
  // before counting so a re-encounter of an already-tombstoned property
  // (impossible today: sampleInto refuses to ever recreate a tombstoned
  // slot) can never double-count the census-level `droppedProperties` stat.
  const dropDivergentProperties = (record: SignatureRecord): void => {
    for (const [cssProperty, slot] of record.properties) {
      if (!isDropWorthySlot(slot)) continue;
      record.properties.delete(cssProperty);
      if (record.tombstonedProperties.has(cssProperty)) continue;
      record.tombstonedProperties.add(cssProperty);
      droppedProperties += 1;
    }
  };

  // Depth-1 refinement, run once per census at traversal completion (and
  // after each ingestAddedElements batch that learned something). Refined
  // records are never refined again (depth cap).
  const refineDivergentSignatures = (): void => {
    // Iterates the Map live (not a snapshot copy): deleting the entry the
    // loop is currently on is spec-defined-safe for Map iteration, and any
    // refined record this same pass inserts is visited later in the same
    // loop but immediately skipped by the `record.refined` check below — a
    // live iteration never re-processes what it just created.
    for (const [signature, record] of records) {
      if (record.refined) continue;
      const divergent = [...record.properties.values()].some(isDivergentSlot);
      if (divergent) refineSignature(signature);
    }

    for (const record of records.values()) {
      dropDivergentProperties(record);
    }
  };

  const soleValue = (values: Set<string>): string | null => {
    if (values.size !== 1) return null;
    return values.values().next().value ?? null;
  };

  // Unlike soleValue, this never rejects on size > 1: an elevation slot that
  // is STILL mixed after refinement (the depth-1 cap left an island and a
  // surface-follower sharing one record) degrades gracefully to first-wins
  // rather than dropping the property outright (C-3) — `elevations` is
  // insertion-ordered, so its first entry is exactly the first
  // representative's own reading.
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
        entries.push({ signature, selector: signatureToSelector(signature), colors });
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

function isTransparentValue(value: string): boolean {
  return value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
}

function isRelevantValue(value: string): boolean {
  return Boolean(value) && !isTransparentValue(value);
}

function emptyPropertySlot(bucket: CensusColor['bucket']): PropertySlot {
  return {
    bucket,
    values: new Set<string>(),
    elevations: new Set<number>(),
    hasOpaqueValue: false,
    hasTransparentRepresentative: false,
  };
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

// Binary island classification (Amendments 3.6 + 3.7): elevation is no
// longer a stacking DEPTH — depth beyond one level is expressed
// positionally in emitted CSS (computedFallback's nested island rules), so
// the census only decides whether the element ITSELF starts a surface (1,
// an island) or follows the surface it sits on (0). The walk goes UP only
// to the NEAREST opaque-background ancestor: the element is an island when
// its hex differs from that ancestor's hex, when its own box-shadow
// qualifies (hasElevationShadow), when it carries a full-perimeter visible
// border (hasFullPerimeterBorder — the hairline cue native-dark sites draw
// instead of a tonal change), or when a transparent wrapper between them
// carries either cue (the pending-boundary carry; a pending cue with no
// opaque node below it simply dies unused). No opaque ancestor at all means
// the element IS the ground — 0 regardless of its own cues, since there is
// no surface beneath it to be raised from. Called only from inside the
// withStylesheetDisabled window sampleInto already runs in, so these
// getComputedStyle reads see the page's authored colors, not ours.
function elevationOf(element: Element): 0 | 1 {
  const style = getComputedStyle(element);
  let pendingWrapperCue = false;

  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor);
    const background = parseCssColor(ancestorStyle.backgroundColor);

    if (!background || !isOpaque(background)) {
      if (hasElevationShadow(ancestorStyle.boxShadow) || hasFullPerimeterBorder(ancestorStyle)) {
        pendingWrapperCue = true;
      }
      continue;
    }

    return isIslandAgainst(style, toHex(background), pendingWrapperCue) ? 1 : 0;
  }

  return 0;
}

// The island decision against the nearest opaque ancestor's surface hex.
// The element's own background can still be translucent here
// (isRelevantValue admits e.g. rgba(x, y, z, 0.5)); toHex is alpha-blind,
// so the hex-difference cue only fires for a genuinely opaque element
// background — the other cues judge the element's box, not its color, and
// apply either way.
function isIslandAgainst(
  style: CSSStyleDeclaration,
  surfaceHex: HexColor,
  pendingWrapperCue: boolean,
): boolean {
  const background = parseCssColor(style.backgroundColor);
  const hexDiffers =
    background !== null && isOpaque(background) && toHex(background) !== surfaceHex;

  return (
    hexDiffers ||
    hasElevationShadow(style.boxShadow) ||
    hasFullPerimeterBorder(style) ||
    pendingWrapperCue
  );
}

// A full-perimeter visible border is an island cue (Amendment 3.6): all
// four sides drawn (style set and neither `none` nor `hidden` — real
// browsers zero a hidden side's used width, but happy-dom does not, so the
// style gate must exclude it explicitly to match browser reality; width
// > 0) in a color anyone can see (alpha > 0 — translucent hairlines like
// LinkedIn post cards' rgba(140, 140, 140, 0.25) COUNT). Single-sided
// borders are dividers and never count — the over-splitting concern that
// originally excluded borders stays addressed. A side color that doesn't
// parse (a keyword, the currentColor default) can't be judged on alpha and
// is treated as visible, same contract as isQualifyingShadowLayer.
function hasFullPerimeterBorder(style: CSSStyleDeclaration): boolean {
  return BORDER_SIDES.every((side) => {
    const sideStyle = style[side.borderStyle];
    if (sideStyle === '' || sideStyle === 'none' || sideStyle === 'hidden') return false;
    // NaN-safe drawn-width gate: an unset side computes to '' in happy-dom
    // (NaN after parseFloat) and must fail exactly like a 0 width.
    const width = Number.parseFloat(style[side.width]);
    if (Number.isNaN(width) || width <= 0) return false;
    const color = parseCssColor(style[side.color]);
    return !color || color.a > 0;
  });
}

// A box-shadow only marks a real elevation boundary when at least one of its
// comma-separated layers is neither `inset` (a pressed/divider effect, drawn
// INSIDE the box, never a stacking cue) nor fully transparent (alpha 0 — a
// shadow no one can see). Splits on top-level commas only: an rgba() color's
// own commas must not be mistaken for layer separators. A layer with no
// rgba()/rgb() color at all (a hex color, a keyword, or the `currentColor`
// default) can't be judged on alpha, so it's treated as visible.
function hasElevationShadow(boxShadow: string): boolean {
  if (boxShadow === '' || boxShadow === 'none') return false;
  return splitTopLevelCommas(boxShadow).some(isQualifyingShadowLayer);
}

function isQualifyingShadowLayer(rawLayer: string): boolean {
  const layer = rawLayer.trim();
  if (layer.includes('inset')) return false;
  const color = parseRgbColor(layer);
  return !color || color.a > 0;
}

// Splits on `,` at paren-depth 0 only — a box-shadow layer's own rgba()/hsla()
// color commas must stay inside that layer, not be read as separating two
// different shadow layers.
function splitTopLevelCommas(value: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of value) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;

    if (character === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);

  return segments;
}
