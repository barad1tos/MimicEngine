import { describe, expect, it } from 'vitest';
import { emitStylePlan, type StylePlan } from './stylePlan';

describe('emitStylePlan', () => {
  it('emits non-empty sections in order and collects coverage in the same order', () => {
    const plan: StylePlan = {
      sections: [
        {
          css: ':root { --pm-canvas: #1f2430; }',
          coverage: { discovered: 4, mapped: 3, ratio: 0.75 },
        },
        { css: '' },
        {
          css: 'body { color: var(--pm-text); }',
          coverage: { discovered: 2, mapped: 1, ratio: 0.5 },
        },
      ],
    };

    expect(emitStylePlan(plan)).toEqual({
      css: ':root { --pm-canvas: #1f2430; }\n\nbody { color: var(--pm-text); }',
      coverages: [
        { discovered: 4, mapped: 3, ratio: 0.75 },
        { discovered: 2, mapped: 1, ratio: 0.5 },
      ],
    });
  });

  it('returns empty output when every section is empty', () => {
    expect(emitStylePlan({ sections: [{ css: '' }, { css: '' }] })).toEqual({
      css: '',
      coverages: [],
    });
  });
});
