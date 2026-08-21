// @vitest-environment happy-dom
// src/core/analyzer/signatureCensus.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignatureCensus } from './signatureCensus';

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

  it('ingestAddedElements returns true when a same-cap twin samples a new distinct color', () => {
    // Two representatives already sampled (2 of the REPRESENTATIVES_PER_SIGNATURE
    // cap of 3), both rgb(1, 1, 1) — the signature is "known", but a third
    // representative introducing a genuinely new value must still count as
    // learned: the refinement pass (Task 3) and the controller's recompose
    // decision (Task 5) both key off this boolean to notice the divergence.
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
