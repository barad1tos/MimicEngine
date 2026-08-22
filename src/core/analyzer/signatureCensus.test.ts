// @vitest-environment happy-dom
// src/core/analyzer/signatureCensus.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CensusColor, CensusSnapshot } from './signatureCensus';
import { createSignatureCensus, installCensus, installedCensus } from './signatureCensus';

const VISIBLE_RECT = {
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  left: 0,
  right: 100,
  bottom: 20,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  // happy-dom's layout engine always reports zero-size rects; stub it so the
  // census' visibility filter lets our fixture elements through, same as any
  // real, laid-out page element would be.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(VISIBLE_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
  installCensus(null);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function fullCensus() {
  const census = createSignatureCensus();
  census.begin(document);
  while (!census.advance(1000)) {
    /* drain */
  }
  return census;
}

// Elevation is BINARY island classification (Amendments 3.6 + 3.7): 1 when
// the element itself starts a surface (hex differs from its nearest opaque
// ancestor, a qualifying box-shadow, a full-perimeter visible border, or a
// transparent wrapper carrying either cue), 0 when it follows the surface
// it sits on. Depth beyond one level is positional — expressed in emitted
// CSS, never in the census.
function backgroundElevationOf(
  entries: CensusSnapshot['entries'],
  selector: string,
): number | undefined {
  return entries
    .find((entry) => entry.selector === selector)
    ?.colors.find((color) => color.bucket === 'background')?.elevation;
}

function backgroundColorOf(
  entries: CensusSnapshot['entries'],
  selector: string,
): CensusColor | undefined {
  return entries
    .find((entry) => entry.selector === selector)
    ?.colors.find((color) => color.bucket === 'background');
}

describe('signatureCensus traversal', () => {
  it('samples one representative set per signature, not per element', () => {
    document.head.innerHTML = '<style>.card { background-color: rgb(1, 2, 3); }</style>';
    document.body.innerHTML = Array.from({ length: 50 }, () => '<div class="card">x</div>').join(
      '',
    );

    const snapshot = fullCensus().snapshot();
    const cardEntries = snapshot.entries.filter((entry) => entry.selector === 'div.card');

    expect(cardEntries).toHaveLength(1);
    expect(snapshot.signatureCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.elementsVisited).toBeGreaterThanOrEqual(50);
  });

  it('is deterministic: two censuses of the same DOM produce equal snapshots', () => {
    document.head.innerHTML = '<style>.a { color: rgb(9, 9, 9); }</style>';
    document.body.innerHTML = '<p class="a">x</p><p class="a">y</p><div class="b">z</div>';

    expect(fullCensus().snapshot()).toEqual(fullCensus().snapshot());
  });

  it('advance() after completion keeps returning true and never throws (walker released)', () => {
    document.body.innerHTML = '<i class="one">a</i>';
    const census = createSignatureCensus();
    census.begin(document);

    expect(census.advance(1000)).toBe(true);
    // A second advance() call past completion must short-circuit cleanly —
    // the TreeWalker was released once traversal finished, so nothing here
    // should attempt to step a null walker.
    expect(() => census.advance(1000)).not.toThrow();
    expect(census.advance(1000)).toBe(true);
  });

  it('advance() reports completion and later snapshots are supersets', () => {
    document.body.innerHTML = '<i class="one">a</i><i class="two">b</i><i class="three">c</i>';
    const census = createSignatureCensus();
    census.begin(document);

    const doneEarly = census.advance(2);
    const early = census.snapshot();
    while (!census.advance(2)) {
      /* drain */
    }
    const late = census.snapshot();

    expect(doneEarly).toBe(false);
    expect(early.complete).toBe(false);
    expect(late.complete).toBe(true);
    for (const entry of early.entries) {
      expect(late.entries.map((candidate) => candidate.selector)).toContain(entry.selector);
    }
  });

  it('collapses uniform drawn border sides to one border-color sample', () => {
    document.head.innerHTML =
      '<style>.btn { color: rgb(10, 20, 30); border: 1px solid rgb(10, 20, 30); }</style>';
    document.body.innerHTML = '<button class="btn">go</button>';

    const entry = fullCensus()
      .snapshot()
      .entries.find((candidate) => candidate.selector === 'button.btn');
    const borderColors = entry?.colors.filter((color) => color.bucket === 'border') ?? [];

    expect(borderColors).toHaveLength(1);
    expect(borderColors[0]?.cssProperty).toBe('border-color');
  });

  it('ingestAddedElements learns new signatures and ignores known ones', () => {
    document.body.innerHTML = '<div class="known">x</div>';
    const census = fullCensus();

    const knownTwin = document.createElement('div');
    knownTwin.className = 'known';
    document.body.append(knownTwin);
    expect(census.ingestAddedElements([knownTwin])).toBe(false);

    const fresh = document.createElement('div');
    fresh.className = 'fresh';
    document.body.append(fresh);
    expect(census.ingestAddedElements([fresh])).toBe(true);
    expect(census.snapshot().entries.some((entry) => entry.selector === 'div.fresh')).toBe(true);
  });

  it('ingestAddedElements returns false when a twin samples only already-known colors', () => {
    // Pins the Set.has de-dup direction with real color values — the
    // existing 'ignores known ones' test above is vacuous under happy-dom's
    // empty computed styles for unstyled elements.
    document.body.innerHTML =
      '<div class="pair" style="color: rgb(1, 1, 1);">a</div>' +
      '<div class="pair" style="color: rgb(1, 1, 1);">b</div>';
    const census = fullCensus();

    const twin = document.createElement('div');
    twin.className = 'pair';
    twin.style.color = 'rgb(1, 1, 1)';
    document.body.append(twin);

    expect(census.ingestAddedElements([twin])).toBe(false);
  });

  it('ingestAddedElements returns true when a same-cap twin samples a new distinct color', () => {
    // Two representatives already sampled (2 of the REPRESENTATIVES_PER_SIGNATURE
    // cap of 3), both rgb(1, 1, 1) — the signature is "known", but a third
    // representative introducing a genuinely new value must still count as
    // learned: the divergence-refinement pass (re-keying signatures whose
    // representatives disagree by parent context) and the controller's
    // decision whether to schedule a census-driven re-apply both key off
    // this boolean to notice the divergence.
    document.body.innerHTML =
      '<div class="pair" style="color: rgb(1, 1, 1);">a</div>' +
      '<div class="pair" style="color: rgb(1, 1, 1);">b</div>';
    const census = fullCensus();

    const twin = document.createElement('div');
    twin.className = 'pair';
    twin.style.color = 'rgb(2, 2, 2)';
    document.body.append(twin);

    expect(census.ingestAddedElements([twin])).toBe(true);
  });

  it('ingestAddedElements walks descendants and learns new signatures nested inside the added element', () => {
    document.body.innerHTML = '<div class="container">x</div>';
    const census = fullCensus();

    const container = document.querySelector('.container');
    if (!(container instanceof HTMLElement)) throw new Error('fixture missing container');
    const child = document.createElement('span');
    child.className = 'child';
    child.style.color = 'rgb(3, 3, 3)';
    container.append(child);

    expect(census.ingestAddedElements([container])).toBe(true);
    expect(census.snapshot().entries.some((entry) => entry.selector === 'span.child')).toBe(true);
  });
});

describe('installCensus / installedCensus', () => {
  it('accessor round-trips and clears', () => {
    const census = createSignatureCensus();
    installCensus(census);
    expect(installedCensus()).toBe(census);
    installCensus(null);
    expect(installedCensus()).toBeNull();
  });
});

describe('divergence refinement', () => {
  it('splits a context-dependent signature by one level of parent', () => {
    document.head.innerHTML = `
      <style>
        .light .btn { color: rgb(0, 0, 0); }
        .dark .btn { color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="light"><button class="btn">a</button></div>
      <div class="dark"><button class="btn">b</button></div>
    `;

    const snapshot = fullCensus().snapshot();
    const selectors = snapshot.entries.map((entry) => entry.selector);

    expect(selectors).toContain('div.light > button.btn');
    expect(selectors).toContain('div.dark > button.btn');
    expect(selectors).not.toContain('button.btn');
    expect(snapshot.droppedProperties).toBe(0);
  });

  it('drops (and counts) a property still divergent after refinement', () => {
    // Same parent signature, different colors via nth-child — depth-1
    // context cannot separate these, so the census must retreat honestly.
    document.head.innerHTML = `
      <style>
        .row:nth-child(1) .cell { color: rgb(1, 1, 1); }
        .row:nth-child(2) .cell { color: rgb(2, 2, 2); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="row"><span class="cell">a</span></div>
      <div class="row"><span class="cell">b</span></div>
    `;

    const snapshot = fullCensus().snapshot();
    const cellEntries = snapshot.entries.filter((entry) => entry.selector.includes('span.cell'));

    expect(cellEntries.every((entry) => entry.colors.every((c) => c.cssProperty !== 'color'))).toBe(
      true,
    );
    expect(snapshot.droppedProperties).toBeGreaterThanOrEqual(1);
  });

  it('both censuses of a divergent DOM still produce equal snapshots', () => {
    document.head.innerHTML = `
      <style>
        .light .btn { color: rgb(0, 0, 0); }
        .dark .btn { color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="light"><button class="btn">a</button></div>
      <div class="dark"><button class="btn">b</button></div>
    `;

    expect(fullCensus().snapshot()).toEqual(fullCensus().snapshot());
  });

  it('ingestAddedElements keys a refined-away raw signature by parent context, not a fresh raw record', () => {
    // Regression for C-1: refineDivergentSignatures() deletes the raw
    // "button|btn" record once it splits by parent context. A naive
    // ingestAddedElements lookup by raw signature then finds nothing for a
    // later-added .btn and creates a fresh UNREFINED "button|btn" record —
    // whose broad `:where(button.btn)` rule would land after the refined
    // rules with equal (zero) specificity and override both contexts by
    // source order.
    document.head.innerHTML = `
      <style>
        .light .btn { color: rgb(0, 0, 0); }
        .dark .btn { color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="light"><button class="btn">a</button></div>
      <div class="dark"><button class="btn">b</button></div>
    `;
    const census = fullCensus();
    expect(census.snapshot().entries.map((entry) => entry.selector)).not.toContain('button.btn');

    const lightContainer = document.querySelector('.light');
    if (!(lightContainer instanceof HTMLElement)) {
      throw new Error('fixture missing .light container');
    }
    const addedButton = document.createElement('button');
    addedButton.className = 'btn';
    // A property no earlier .btn sample carries, so a successful land under
    // the refined key is unambiguous evidence — not just an untouched
    // leftover from the original refinement pass.
    addedButton.style.backgroundColor = 'rgb(9, 9, 9)';
    lightContainer.append(addedButton);

    expect(census.ingestAddedElements([addedButton])).toBe(true);

    const snapshot = census.snapshot();
    const selectors = snapshot.entries.map((entry) => entry.selector);
    expect(selectors).not.toContain('button.btn');
    const lightEntry = snapshot.entries.find(
      (entry) => entry.selector === 'div.light > button.btn',
    );
    expect(lightEntry?.colors).toContainEqual({
      cssProperty: 'background-color',
      bucket: 'background',
      value: 'rgb(9, 9, 9)',
      elevation: 0,
    });
  });
});

describe('background elevation', () => {
  it('classifies islands by their own boundary cue, not by ancestor depth', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
        .chip { background-color: rgb(240, 240, 240); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><section class="card"><span class="chip">x</span></section></div>';

    const entries = fullCensus().snapshot().entries;

    // .card shares .ground's exact hex — only its own box-shadow makes it a
    // new surface.
    expect(backgroundElevationOf(entries, 'div.ground')).toBe(0);
    expect(backgroundElevationOf(entries, 'section.card')).toBe(1);
    // .chip differs from .card's hex — an island in its own right. Its
    // depth (two surfaces up from the ground) is positional, so the census
    // still reads 1, never 2.
    expect(backgroundElevationOf(entries, 'span.chip')).toBe(1);
  });

  it('keeps same-hex, unshadowed nesting at one visual surface (the notifications wash-out regression)', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); }
        .row { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><section class="card"><span class="row">x</span></section></div>';

    const entries = fullCensus().snapshot().entries;
    const elevations = ['div.ground', 'section.card', 'span.row'].map((selector) =>
      backgroundElevationOf(entries, selector),
    );

    // Nothing here ever changes hex or carries a shadow: ground, card, and
    // row are one single visual surface, all reading elevation 0 — a raw
    // ancestor count would instead report 0, 1, 2 and wash out the nested
    // content under progressively lighter surface tokens.
    expect(elevations).toEqual([0, 0, 0]);
  });

  it('bumps elevation on a color boundary alone, with no shadow involved', () => {
    // The Network-page case: a plain grey ground with a white card dropped
    // on top, no box-shadow anywhere.
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(200, 200, 200); }
        .card { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><section class="card">x</section></div>';

    const entries = fullCensus().snapshot().entries;

    expect(backgroundElevationOf(entries, 'div.ground')).toBe(0);
    expect(backgroundElevationOf(entries, 'section.card')).toBe(1);
  });

  it('transparent ancestors do not count toward elevation (real color boundary still bumps)', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(250, 250, 250); }
        .island { background-color: rgb(230, 230, 230); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><div class="wrapper"><div class="island">x</div></div></div>';

    const entries = fullCensus().snapshot().entries;

    // .wrapper has no declared background (transparent) and sits between
    // .ground and .island: it must contribute nothing of its own — the
    // single bump here comes entirely from .island's real color difference
    // from .ground, not from the wrapper being "one more ancestor".
    expect(backgroundElevationOf(entries, 'div.island')).toBe(1);
  });

  it('text and border colors never carry elevation', () => {
    document.head.innerHTML =
      '<style>.t { color: rgb(1, 2, 3); border: 1px solid rgb(1, 2, 3); }</style>';
    document.body.innerHTML = '<p class="t">x</p>';

    const entry = fullCensus()
      .snapshot()
      .entries.find((candidate) => candidate.selector === 'p.t');
    for (const color of entry?.colors ?? []) {
      if (color.bucket !== 'background') expect(color.elevation).toBeUndefined();
    }
  });
});

describe('shadow boundary refinements (Codex P2s)', () => {
  it('a transparent wrapper carrying the shadow still creates a boundary for its opaque child', () => {
    // The shadow that makes this a new surface lives on the TRANSPARENT
    // .wrapper, not on .child itself — a naive fold that skips non-opaque
    // nodes outright would lose that shadow entirely and, since .child
    // shares .ground's exact hex, silently fold it back into .ground's
    // surface (elevation 0). The pending-shadow-boundary carry must survive
    // the skip and land on the next opaque node.
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .wrapper { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
        .child { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><div class="wrapper"><div class="child">x</div></div></div>';

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, 'div.child')).toBe(1);
  });

  it('a shadowless transparent wrapper leaves a same-hex child at the same surface', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .wrapper { }
        .child { background-color: rgb(255, 255, 255); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><div class="wrapper"><div class="child">x</div></div></div>';

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, 'div.child')).toBe(0);
  });

  it('an inset-only shadow never creates a boundary', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2); }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><section class="card">x</section></div>';

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, 'section.card')).toBe(0);
  });

  it('a fully-transparent (alpha 0) shadow never creates a boundary', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); box-shadow: rgba(0, 0, 0, 0) 0px 1px 3px; }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><section class="card">x</section></div>';

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, 'section.card')).toBe(0);
  });

  it('a multi-shadow value bumps once a single segment qualifies, inset segments aside', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(255, 255, 255); }
        .card {
          background-color: rgb(255, 255, 255);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), rgba(0, 0, 0, 0.2) 0 1px 2px;
        }
      </style>
    `;
    document.body.innerHTML = '<div class="ground"><section class="card">x</section></div>';

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, 'section.card')).toBe(1);
  });
});

describe('island cues (Amendments 3.6 + 3.7)', () => {
  // One target element per case; expected is the census's BINARY island
  // classification for its background sample. The hairline-border cue
  // (Amendment 3.6) mirrors what native-dark sites actually draw: LinkedIn
  // post cards delimit same-hex islands with a full 4-side
  // `1px rgba(140, 140, 140, 0.25)` border, no tonal change at all.
  const cases: {
    name: string;
    head: string;
    body: string;
    selector: string;
    expected: 0 | 1;
  }[] = [
    {
      name: 'a full-perimeter translucent hairline border makes a same-hex element an island',
      head: `<style>
        .ground { background-color: rgb(29, 34, 38); }
        .card { background-color: rgb(29, 34, 38); border: 1px solid rgba(140, 140, 140, 0.25); }
      </style>`,
      body: '<div class="ground"><section class="card">x</section></div>',
      selector: 'section.card',
      expected: 1,
    },
    {
      name: 'a single-sided border (divider) never counts — the element stays surface-following',
      head: `<style>
        .ground { background-color: rgb(29, 34, 38); }
        .row { background-color: rgb(29, 34, 38); border-bottom: 1px solid rgba(140, 140, 140, 0.25); }
      </style>`,
      body: '<div class="ground"><section class="row">x</section></div>',
      selector: 'section.row',
      expected: 0,
    },
    {
      name: 'same hex with no cue at all is surface-following',
      head: `<style>
        .ground { background-color: rgb(29, 34, 38); }
        .inner { background-color: rgb(29, 34, 38); }
      </style>`,
      body: '<div class="ground"><section class="inner">x</section></div>',
      selector: 'section.inner',
      expected: 0,
    },
    {
      name: 'a hex differing from the nearest opaque ancestor is an island',
      head: `<style>
        .ground { background-color: rgb(29, 34, 38); }
        .panel { background-color: rgb(45, 50, 55); }
      </style>`,
      body: '<div class="ground"><section class="panel">x</section></div>',
      selector: 'section.panel',
      expected: 1,
    },
    {
      name: 'a transparent wrapper carrying a full-perimeter border makes its opaque child an island',
      head: `<style>
        .ground { background-color: rgb(29, 34, 38); }
        .frame { border: 1px solid rgba(140, 140, 140, 0.25); }
        .child { background-color: rgb(29, 34, 38); }
      </style>`,
      body: '<div class="ground"><div class="frame"><div class="child">x</div></div></div>',
      selector: 'div.child',
      expected: 1,
    },
    {
      name: 'no opaque ancestor at all means the element IS the ground — 0 despite its own cues',
      head: `<style>
        .floating {
          background-color: rgb(29, 34, 38);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
          border: 1px solid rgba(140, 140, 140, 0.25);
        }
      </style>`,
      body: '<div class="floating">x</div>',
      selector: 'div.floating',
      expected: 0,
    },
  ];

  it.each(cases)('$name', ({ head, body, selector, expected }) => {
    document.head.innerHTML = head;
    document.body.innerHTML = body;

    const entries = fullCensus().snapshot().entries;
    expect(backgroundElevationOf(entries, selector)).toBe(expected);
  });
});

describe('background transparency divergence (Amendment 3.3)', () => {
  // Present-vs-absent divergence: a signature whose representatives mix a
  // relevant (opaque) background with an explicitly transparent one — e.g.
  // active vs. inactive filter pills sharing one signature — must never let
  // the opaque representative paint every match. Before this fix,
  // `isRelevantValue` dropped the transparent samples BEFORE they ever
  // reached the record, so the signature silently read as "opaque, size 1"
  // and painted flakily depending on K-representative order.
  // (backgroundColorOf lives at module scope — shared with the
  // resurrection-guard describe block below.)

  it('drops the background (and counts it) when opaque/transparent siblings share one signature with no distinguishing parent', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: transparent;">b</span>
        <span class="pill" style="background-color: rgba(0, 0, 0, 0);">c</span>
      </div>
    `;

    const snapshot = fullCensus().snapshot();
    const selectors = snapshot.entries.map((entry) => entry.selector);

    // Refinement re-keys by parent context, but all three siblings share the
    // exact same parent (`.group`) — there is no split that separates the
    // opaque one from the transparent ones, so the refined record is STILL
    // mixed and must retreat honestly rather than guess.
    expect(selectors).not.toContain('span.pill');
    const refinedSelector = 'div.group > span.pill';
    expect(selectors).toContain(refinedSelector);
    expect(backgroundColorOf(snapshot.entries, refinedSelector)).toBeUndefined();
    expect(snapshot.droppedProperties).toBeGreaterThanOrEqual(1);
  });

  it('splits opaque and transparent siblings by parent context when a real distinguishing context exists', () => {
    document.head.innerHTML = `
      <style>
        .light .pill { color: rgb(1, 1, 1); }
        .dark .pill { color: rgb(2, 2, 2); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="light"><span class="pill" style="background-color: rgb(10, 20, 30);">a</span></div>
      <div class="dark"><span class="pill" style="background-color: transparent;">b</span></div>
    `;

    const snapshot = fullCensus().snapshot();
    const selectors = snapshot.entries.map((entry) => entry.selector);

    expect(selectors).not.toContain('span.pill');
    expect(selectors).toContain('div.light > span.pill');
    expect(selectors).toContain('div.dark > span.pill');

    // The opaque side keeps its own background intact once split away from
    // the transparent side.
    expect(backgroundColorOf(snapshot.entries, 'div.light > span.pill')).toEqual({
      cssProperty: 'background-color',
      bucket: 'background',
      value: 'rgb(10, 20, 30)',
      elevation: 0,
    });
    // The transparent side never gets an opaque color to paint.
    expect(backgroundColorOf(snapshot.entries, 'div.dark > span.pill')).toBeUndefined();
    expect(snapshot.droppedProperties).toBe(0);
  });

  it('leaves an all-transparent signature unchanged: no background entry, no drop counted', () => {
    document.body.innerHTML = `
      <span class="ghost" style="background-color: transparent;">a</span>
      <span class="ghost" style="background-color: rgba(0, 0, 0, 0);">b</span>
    `;

    const snapshot = fullCensus().snapshot();
    const entry = snapshot.entries.find((candidate) => candidate.selector === 'span.ghost');

    expect(entry).toBeDefined();
    expect(entry?.colors.some((color) => color.bucket === 'background')).toBe(false);
    expect(snapshot.droppedProperties).toBe(0);
  });

  it('both censuses of a transparent-mixed DOM still produce equal snapshots (determinism)', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: transparent;">b</span>
      </div>
    `;

    expect(fullCensus().snapshot()).toEqual(fullCensus().snapshot());
  });

  it('later snapshots stay a superset of earlier ones on a transparent-mixed DOM (monotonicity)', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: transparent;">b</span>
        <span class="pill" style="background-color: rgba(0, 0, 0, 0);">c</span>
      </div>
    `;
    const census = createSignatureCensus();
    census.begin(document);

    census.advance(2);
    const early = census.snapshot();
    while (!census.advance(2)) {
      /* drain */
    }
    const late = census.snapshot();

    for (const entry of early.entries) {
      expect(late.entries.map((candidate) => candidate.selector)).toContain(entry.selector);
    }
  });

  // The live-SPA flakiness scenario Amendment 3.3 targets: a signature
  // census'd to COMPLETION with only opaque representatives (no divergence,
  // no refinement yet), then a state-differing twin (e.g. a filter pill that
  // flips to its "inactive"/transparent state) arrives later through a DOM
  // mutation. ingestAddedElements' post-ingest refinement pass must catch
  // this exactly like the initial-traversal path does — the bug this
  // amendment fixes was specifically about a representative's OWN sample
  // order, and a mutation-added twin is the most realistic way that order
  // varies across page loads.
  it('mutation-triggered divergence: a same-parent transparent twin added post-completion cannot be split away, so the background drops', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: rgb(10, 20, 30);">b</span>
      </div>
    `;
    const census = fullCensus();
    const before = census.snapshot();

    // Two opaque representatives, one slot short of the K=3 cap, not yet
    // divergent — no refinement has happened at this point.
    expect(before.entries.map((entry) => entry.selector)).toContain('span.pill');
    expect(backgroundColorOf(before.entries, 'span.pill')).toEqual({
      cssProperty: 'background-color',
      bucket: 'background',
      value: 'rgb(10, 20, 30)',
      elevation: 0,
    });
    expect(before.droppedProperties).toBe(0);

    const group = document.querySelector('.group');
    if (!(group instanceof HTMLElement)) throw new Error('fixture missing .group container');
    const twin = document.createElement('span');
    twin.className = 'pill';
    twin.style.backgroundColor = 'transparent';
    group.append(twin);

    // The twin lands in the last open representative slot and its explicit
    // transparent background is genuinely new, divergence-worthy signal.
    expect(census.ingestAddedElements([twin])).toBe(true);

    const after = census.snapshot();
    const selectors = after.entries.map((entry) => entry.selector);
    // All three siblings share the exact same parent — refinement re-keys
    // by parent context but finds no distinguishing context between them,
    // so the refined record is STILL a mix and must retreat honestly rather
    // than paint every match opaque depending on which representative
    // happened to land first.
    expect(selectors).not.toContain('span.pill');
    const refinedSelector = 'div.group > span.pill';
    expect(selectors).toContain(refinedSelector);
    expect(backgroundColorOf(after.entries, refinedSelector)).toBeUndefined();
    expect(after.droppedProperties).toBeGreaterThanOrEqual(1);
  });

  it('mutation-triggered divergence: a different-parent transparent twin splits cleanly, the opaque side keeps its background', () => {
    document.body.innerHTML = `
      <div class="light">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: rgb(10, 20, 30);">b</span>
      </div>
      <div class="dark"></div>
    `;
    const census = fullCensus();
    expect(census.snapshot().droppedProperties).toBe(0);

    const darkContainer = document.querySelector('.dark');
    if (!(darkContainer instanceof HTMLElement)) {
      throw new Error('fixture missing .dark container');
    }
    const twin = document.createElement('span');
    twin.className = 'pill';
    twin.style.backgroundColor = 'transparent';
    darkContainer.append(twin);

    expect(census.ingestAddedElements([twin])).toBe(true);

    const after = census.snapshot();
    const selectors = after.entries.map((entry) => entry.selector);

    // A real distinguishing parent exists this time — refinement separates
    // the opaque siblings from the transparent twin instead of retreating.
    expect(selectors).not.toContain('span.pill');
    expect(selectors).toContain('div.light > span.pill');
    expect(selectors).toContain('div.dark > span.pill');

    expect(backgroundColorOf(after.entries, 'div.light > span.pill')).toEqual({
      cssProperty: 'background-color',
      bucket: 'background',
      value: 'rgb(10, 20, 30)',
      elevation: 0,
    });
    // The transparent twin's own side never gets an opaque color to paint.
    expect(backgroundColorOf(after.entries, 'div.dark > span.pill')).toBeUndefined();
    expect(after.droppedProperties).toBe(0);
  });
});

describe('elevation divergence (C-3)', () => {
  it('splits same-hex backgrounds with different island classification into separate refined records, without dropping', () => {
    // Two `.card` elements share tag+class AND the exact same background
    // hex -- the color itself never diverges -- but only one of them is an
    // island: card A sits on a same-hex ground with no cue of its own
    // (surface-following, 0), card B sits on a DIFFERENT-hex ground (the
    // hex difference is its boundary cue, 1). Divergent island-ness across
    // representatives goes through the standard refine-then-drop machinery:
    // a split, never a silent first-wins collapse.
    document.head.innerHTML = `
      <style>
        .groundLight { background-color: rgb(250, 250, 250); }
        .groundDark { background-color: rgb(200, 200, 200); }
        .card { background-color: rgb(250, 250, 250); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="groundLight"><section class="card">A</section></div>
      <div class="groundDark"><section class="card">B</section></div>
    `;

    const snapshot = fullCensus().snapshot();
    const selectors = snapshot.entries.map((entry) => entry.selector);

    // Refined into two parent-qualified selectors -- never one broad,
    // island-blind `section.card` rule.
    expect(selectors).not.toContain('section.card');
    expect(selectors).toContain('div.groundLight > section.card');
    expect(selectors).toContain('div.groundDark > section.card');

    expect(backgroundElevationOf(snapshot.entries, 'div.groundLight > section.card')).toBe(0);
    expect(backgroundElevationOf(snapshot.entries, 'div.groundDark > section.card')).toBe(1);

    // A split, not a drop: island-ness disagreement degrades gracefully --
    // both refined records keep their background-color property intact.
    expect(snapshot.droppedProperties).toBe(0);
  });
});

describe('resurrection guard: tombstoned drops never come back (Codex census, PR #18)', () => {
  // Deleting a dropped property's slot alone erases only the CURRENT
  // sample, not the fact that a conflict was ever seen. A record still
  // under the K=3 representative cap -- or one already `refined` (refinement
  // never revisits it, so nothing else re-detects the conflict) -- that
  // gains one more representative via ingestAddedElements would otherwise
  // recreate a fresh, single-value slot and silently resurrect the exact
  // painted-wrong-color bug Amendment 3.3's drop existed to prevent. Each
  // record's own tombstone set (`tombstonedProperties`, distinct from the
  // census-level `droppedProperties` COUNT) closes that gap: sampleInto
  // refuses to record into a tombstoned property at all, for this record's
  // entire lifetime.

  it('a same-parent refined record already dropped for a transparent mix stays dropped when a third opaque rep arrives', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: transparent;">b</span>
      </div>
    `;
    const census = fullCensus();
    const before = census.snapshot();
    const refinedSelector = 'div.group > span.pill';

    // Only 2 of the K=3 representative slots are filled -- the refined
    // record already dropped its background (unsplittable: both siblings
    // share the exact same parent), leaving one slot open.
    expect(before.entries.map((entry) => entry.selector)).toContain(refinedSelector);
    expect(backgroundColorOf(before.entries, refinedSelector)).toBeUndefined();
    expect(before.droppedProperties).toBe(1);

    const group = document.querySelector('.group');
    if (!(group instanceof HTMLElement)) throw new Error('fixture missing .group container');
    const thirdSibling = document.createElement('span');
    thirdSibling.className = 'pill';
    // Agrees with the very first (opaque) representative -- on its own,
    // this would look like clean, unanimous single-value evidence.
    thirdSibling.style.backgroundColor = 'rgb(10, 20, 30)';
    group.append(thirdSibling);

    census.ingestAddedElements([thirdSibling]);

    const after = census.snapshot();
    // The tombstone holds: sampleInto refused to record into the dropped
    // property at all, so no fresh single-value slot was ever created.
    expect(backgroundColorOf(after.entries, refinedSelector)).toBeUndefined();
    // Counted exactly once, at the original drop -- the later re-encounter
    // must never inflate the statistic.
    expect(after.droppedProperties).toBe(1);
  });

  it('a same-parent refined record already dropped for a value mismatch stays dropped when an agreeing rep arrives', () => {
    document.head.innerHTML = `
      <style>
        .row:nth-child(1) .cell { color: rgb(1, 1, 1); }
        .row:nth-child(2) .cell { color: rgb(2, 2, 2); }
      </style>
    `;
    document.body.innerHTML = `
      <div class="row"><span class="cell">a</span></div>
      <div class="row"><span class="cell">b</span></div>
    `;
    const census = fullCensus();
    const before = census.snapshot();
    const refinedSelector = 'div.row > span.cell';

    const beforeEntry = before.entries.find((entry) => entry.selector === refinedSelector);
    expect(beforeEntry).toBeDefined();
    expect(beforeEntry?.colors.every((color) => color.cssProperty !== 'color')).toBe(true);
    expect(before.droppedProperties).toBe(1);

    // A third `.row > .cell` occurrence, agreeing with the first sample --
    // depth-1 refinement keys purely on the parent's tag+class, so this
    // still lands in the SAME refined record (nth-child plays no part in
    // the refined key), one slot short of the K=3 cap.
    const newRow = document.createElement('div');
    newRow.className = 'row';
    const newCell = document.createElement('span');
    newCell.className = 'cell';
    newCell.style.color = 'rgb(1, 1, 1)';
    newRow.append(newCell);
    document.body.append(newRow);

    census.ingestAddedElements([newRow]);

    const after = census.snapshot();
    const afterEntry = after.entries.find((entry) => entry.selector === refinedSelector);
    expect(afterEntry?.colors.every((color) => color.cssProperty !== 'color')).toBe(true);
    expect(after.droppedProperties).toBe(1);
  });

  it('a fresh census (bootstrap) after the conflicting sibling is gone sees the background normally again', () => {
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
        <span class="pill" style="background-color: transparent;">b</span>
      </div>
    `;
    const staleCensus = fullCensus();
    const refinedSelector = 'div.group > span.pill';
    expect(backgroundColorOf(staleCensus.snapshot().entries, refinedSelector)).toBeUndefined();

    // Simulates an SPA route change: the conflicting (transparent) sibling
    // is gone from the DOM, and the controller bootstraps a brand-new
    // census (a fresh createSignatureCensus(), never the stale object) --
    // tombstones live only on the OLD census's own records.
    document.body.innerHTML = `
      <div class="group">
        <span class="pill" style="background-color: rgb(10, 20, 30);">a</span>
      </div>
    `;
    const freshSnapshot = fullCensus().snapshot();

    expect(backgroundColorOf(freshSnapshot.entries, 'span.pill')).toEqual({
      cssProperty: 'background-color',
      bucket: 'background',
      value: 'rgb(10, 20, 30)',
      elevation: 0,
    });
    expect(freshSnapshot.droppedProperties).toBe(0);
  });
});
