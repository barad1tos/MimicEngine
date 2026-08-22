// @vitest-environment happy-dom
// src/core/analyzer/styleSignature.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeRefinedSignature,
  computeSignature,
  isLeafClassSuperset,
  signatureToSelector,
} from './styleSignature';

function elementFromHtml(html: string): Element {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild;
  if (!element) throw new Error('fixture produced no element');
  return element;
}

describe('computeSignature', () => {
  it('keys by lowercase tag plus lexicographically sorted classes', () => {
    const element = elementFromHtml('<DIV class="zeta alpha"></DIV>');
    expect(computeSignature(element)).toBe('div|alpha|zeta');
  });

  it('deduplicates repeated classes', () => {
    const element = elementFromHtml('<div class="a a b"></div>');
    expect(computeSignature(element)).toBe('div|a|b');
  });

  it('is tag-only for class-less elements', () => {
    expect(computeSignature(elementFromHtml('<span></span>'))).toBe('span');
  });

  it('covers SVG elements (className is SVGAnimatedString there)', () => {
    const element = elementFromHtml('<svg class="icon small"></svg>');
    expect(computeSignature(element)).toBe('svg|icon|small');
  });
});

describe('computeRefinedSignature', () => {
  it('prefixes exactly one level of parent context', () => {
    const parent = elementFromHtml('<div class="card"><button class="btn"></button></div>');
    const child = parent.firstElementChild;
    if (!child) throw new Error('no child');
    expect(computeRefinedSignature(child)).toBe('div|card > button|btn');
  });

  it('falls back to the own key at the document root', () => {
    expect(computeRefinedSignature(document.documentElement)).toBe('html');
  });
});

describe('signatureToSelector', () => {
  it('escapes utility classes with special characters', () => {
    expect(signatureToSelector('a|focus:top-0|b')).toBe('a.focus\\:top-0.b');
  });

  it('joins refined signatures with a child combinator', () => {
    expect(signatureToSelector('div|card > button|btn')).toBe('div.card > button.btn');
  });
});

describe('computeSignature — C-3: pipe is a legal class character', () => {
  it('keys a literal-pipe class differently from splitting the same characters into two classes', () => {
    const pipeClass = elementFromHtml('<div class="foo|bar"></div>');
    const twoClasses = elementFromHtml('<div class="bar foo"></div>');

    expect(computeSignature(pipeClass)).not.toBe(computeSignature(twoClasses));
  });

  it('round-trips a literal-pipe class to a selector that matches the sampled element', () => {
    document.body.innerHTML = '<div class="foo|bar"></div>';
    const element = document.body.firstElementChild;
    if (!element) throw new Error('fixture produced no element');

    const signature = computeSignature(element);
    const selector = signatureToSelector(signature);

    expect(document.querySelector(selector)).toBe(element);
  });

  it('keeps refined-form splitting (" > ") working when a class contains a pipe', () => {
    const parent = elementFromHtml('<div class="card"><button class="foo|bar"></button></div>');
    const child = parent.firstElementChild;
    if (!child) throw new Error('no child');

    const refined = computeRefinedSignature(child);
    const selector = signatureToSelector(refined);

    expect(selector.includes(' > ')).toBe(true);
    expect(document.querySelector(selector)).toBe(child);
  });
});

describe('isLeafClassSuperset', () => {
  it('accepts a strict class superset on the same leaf tag', () => {
    expect(isLeafClassSuperset('div|card|flat', 'div|card')).toBe(true);
  });

  it('rejects equal class sets', () => {
    expect(isLeafClassSuperset('div|card', 'div|card')).toBe(false);
  });

  it('rejects the subset direction', () => {
    expect(isLeafClassSuperset('div|card', 'div|card|flat')).toBe(false);
  });

  it('rejects a disjoint class set', () => {
    expect(isLeafClassSuperset('div|flat', 'div|card')).toBe(false);
  });

  it('rejects differing leaf tags even with a class superset', () => {
    expect(isLeafClassSuperset('span|card|flat', 'div|card')).toBe(false);
  });

  it('treats an escaped-pipe class as one token, not two', () => {
    expect(isLeafClassSuperset('div|foo\\|bar|x', 'div|foo\\|bar')).toBe(true);
    expect(isLeafClassSuperset('div|bar|foo|x', 'div|foo\\|bar')).toBe(false);
  });

  it('compares refined forms by their leaf compound', () => {
    expect(isLeafClassSuperset('div|row > div|card|flat', 'div|card')).toBe(true);
    expect(isLeafClassSuperset('div|card|flat', 'section|wrap > div|card')).toBe(true);
  });

  it('never matches through the refined parent part alone', () => {
    expect(isLeafClassSuperset('div|card|flat > button|btn', 'div|card')).toBe(false);
  });
});

describe('signatureToSelector without CSS.escape (fallback branch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('escapes a leading-digit class exactly like native CSS.escape', () => {
    // happy-dom implements CSS.escape, so this reads the real algorithm's
    // output as the expectation before removing CSS to force our fallback.
    const expected = `div.${CSS.escape('2xl:hidden')}`;
    vi.stubGlobal('CSS', undefined);

    expect(signatureToSelector('div|2xl:hidden')).toBe(expected);
  });

  it('still escapes non-digit-leading utility classes without CSS.escape', () => {
    const expected = `a.${CSS.escape('focus:top-0')}.b`;
    vi.stubGlobal('CSS', undefined);

    expect(signatureToSelector('a|focus:top-0|b')).toBe(expected);
  });
});
