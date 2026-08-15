import { describe, expect, it } from 'vitest';
import { DECISION_TABLE, TABLE_VERSION, decideStrategies } from './decisionTable';
import type { PageMetrics } from './pageMetrics';

const baseMetrics: PageMetrics = {
  colorCustomPropertyCount: 0,
  domElementCount: 100,
  shadowRootCount: 0,
  unreadableStylesheetRatio: 0,
};

describe('decideStrategies', () => {
  it('selects variables-capable when colorCustomPropertyCount >= 8', () => {
    const metrics: PageMetrics = { ...baseMetrics, colorCustomPropertyCount: 8 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline', 'variableRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'variables-capable',
      reasons: [{ metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } }],
      tableVersion: TABLE_VERSION,
    });
  });

  it('falls through to default when no other row matches', () => {
    const plan = decideStrategies(baseMetrics, 'auto');

    expect(plan.strategies).toEqual(['baseline']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'default',
      reasons: [],
      tableVersion: TABLE_VERSION,
    });
  });

  it('boundary: 8 selects variables-capable, 7 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 8 }, 'auto');
    const belowBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 7 }, 'auto');

    expect(atBoundary.strategies).toEqual(['baseline', 'variableRemap']);
    expect(belowBoundary.strategies).toEqual(['baseline']);
  });

  it('manual override bypasses the table entirely', () => {
    const plan = decideStrategies(baseMetrics, 'variableRemap');

    expect(plan).toEqual({
      strategies: ['variableRemap'],
      provenance: { kind: 'manual', strategy: 'variableRemap' },
    });
  });

  it('the table is total: the last row matches unconditionally', () => {
    expect(DECISION_TABLE.at(-1)?.when).toEqual({});
  });
});
