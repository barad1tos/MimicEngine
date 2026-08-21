// @vitest-environment happy-dom
// src/core/analyzer/signatureCensus.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('records background elevation as the count of opaque-background ancestors', () => {
    document.head.innerHTML = `
      <style>
        .page { background-color: rgb(255, 255, 255); }
        .card { background-color: rgb(255, 255, 255); }
        .chip { background-color: rgb(240, 240, 240); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="page"><section class="card"><span class="chip">x</span></section></div>';

    const entries = fullCensus().snapshot().entries;
    const elevationOf = (selector: string): number | undefined =>
      entries
        .find((entry) => entry.selector === selector)
        ?.colors.find((color) => color.bucket === 'background')?.elevation;

    expect(elevationOf('div.page')).toBe(0);
    expect(elevationOf('section.card')).toBe(1);
    expect(elevationOf('span.chip')).toBe(2);
  });

  it('transparent ancestors do not count toward elevation', () => {
    document.head.innerHTML = `
      <style>
        .ground { background-color: rgb(250, 250, 250); }
        .island { background-color: rgb(250, 250, 250); }
      </style>
    `;
    document.body.innerHTML =
      '<div class="ground"><div class="wrapper"><div class="island">x</div></div></div>';

    const entries = fullCensus().snapshot().entries;
    const island = entries.find((entry) => entry.selector === 'div.island');
    expect(island?.colors.find((color) => color.bucket === 'background')?.elevation).toBe(1);
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
