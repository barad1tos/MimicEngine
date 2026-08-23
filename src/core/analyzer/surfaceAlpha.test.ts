// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { CensusSnapshot } from './signatureCensus';
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

function censusSnapshot(styles: string, markup: string): CensusSnapshot {
  document.head.innerHTML = `<style>${styles}</style>`;
  document.body.innerHTML = markup;
  const visibility = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue(VISIBLE_RECT);

  try {
    const census = createSignatureCensus();
    census.begin(document);
    while (!census.advance(1000)) {
      /* drain */
    }
    return census.snapshot();
  } finally {
    visibility.mockRestore();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  }
}

function backgroundValue(snapshot: CensusSnapshot, selector: string): string | undefined {
  return snapshot.entries
    .find((entry) => entry.selector === selector)
    ?.colors.find((color) => color.bucket === 'background')?.value;
}

describe('computed surface alpha normalization', () => {
  it('resolves a nearly opaque surface against its opaque ancestor', () => {
    const snapshot = censusSnapshot(
      'body { background-color: rgb(36, 41, 54); } .surface { background-color: rgba(0, 0, 0, 0.9); }',
      '<div class="surface">content</div>',
    );

    const surface = snapshot.entries
      .find((entry) => entry.selector === 'div.surface')
      ?.colors.find((color) => color.bucket === 'background');

    expect(surface).toMatchObject({ value: '#040405', elevation: 1 });
    expect(snapshot.opaqueValuesSeen).toContain('#040405');
  });

  it('keeps a translucent scrim outside the opaque remap palette', () => {
    const snapshot = censusSnapshot(
      'body { background-color: rgb(36, 41, 54); } .scrim { background-color: rgba(0, 0, 0, 0.5); }',
      '<div class="scrim">content</div>',
    );

    expect(backgroundValue(snapshot, 'div.scrim')).toBe('rgba(0, 0, 0, 0.5)');
    expect(snapshot.opaqueValuesSeen).not.toContain('rgba(0, 0, 0, 0.5)');
  });

  it('does not guess through a translucent ancestor backdrop', () => {
    const snapshot = censusSnapshot(
      'body { background-color: rgb(36, 41, 54); } .layer { background-color: rgba(100, 120, 140, 0.5); } .surface { background-color: rgba(0, 0, 0, 0.9); }',
      '<div class="layer"><div class="surface">content</div></div>',
    );

    expect(backgroundValue(snapshot, 'div.surface')).toBe('rgba(0, 0, 0, 0.9)');
    expect(snapshot.opaqueValuesSeen).not.toContain('rgba(0, 0, 0, 0.9)');
  });
});
