import { describe, expect, it } from 'vitest';
import { deriveMetrics } from './pageMetrics';
import type { PageFacts } from './pageFacts';

const base: PageFacts = {
  customProperties: [],
  authoredRules: [],
  inlineStyleColors: [],
  domElementCount: 100,
  shadowRootCount: 2,
  styleSheetCount: 4,
  unreadableStyleSheetCount: 1,
};

describe('deriveMetrics', () => {
  it('counts only color-valued custom properties', () => {
    const facts: PageFacts = {
      ...base,
      customProperties: [
        {
          name: '--a',
          value: '#fff',
          color: { r: 255, g: 255, b: 255, a: 1 },
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
        {
          name: '--b',
          value: '4px',
          color: null,
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
      ],
    };
    expect(deriveMetrics(facts).colorCustomPropertyCount).toBe(1);
  });

  it('computes unreadable ratio and passes counters through', () => {
    const metrics = deriveMetrics(base);
    expect(metrics.unreadableStylesheetRatio).toBeCloseTo(0.25);
    expect(metrics.domElementCount).toBe(100);
    expect(metrics.shadowRootCount).toBe(2);
    expect(
      deriveMetrics({ ...base, styleSheetCount: 0, unreadableStyleSheetCount: 0 })
        .unreadableStylesheetRatio,
    ).toBe(0);
  });
});
