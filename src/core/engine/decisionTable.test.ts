import { describe, expect, it } from 'vitest';
import { DECISION_TABLE, TABLE_VERSION, decideStrategies } from './decisionTable';
import type { PageMetrics } from './pageMetrics';

const baseMetrics: PageMetrics = {
  colorCustomPropertyCount: 0,
  domElementCount: 100,
  shadowRootCount: 0,
  unreadableStylesheetRatio: 0,
  authoredColorCount: 0,
  inlineStyleColorCount: 0,
  customPropertyColorRatio: 0,
  mutationRate: 0,
};

describe('decideStrategies', () => {
  it('selects calm-variables-rich when colorCustomPropertyCount >= 8 and mutationRate <= 5', () => {
    const metrics: PageMetrics = { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 5 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'calm-variables-rich',
      reasons: [
        { metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } },
        { metric: 'mutationRate', value: 5, condition: { lte: 5 } },
      ],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects variables-capable when colorCustomPropertyCount >= 8 but mutationRate > 5', () => {
    const metrics: PageMetrics = { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 6 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline', 'variableRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'variables-capable',
      reasons: [{ metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } }],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects authored-rich when authoredColorCount >= 12 and mutationRate <= 5', () => {
    const metrics: PageMetrics = { ...baseMetrics, authoredColorCount: 12, mutationRate: 5 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline', 'authoredRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'authored-rich',
      reasons: [
        { metric: 'authoredColorCount', value: 12, condition: { gte: 12 } },
        { metric: 'mutationRate', value: 5, condition: { lte: 5 } },
      ],
      tableVersion: TABLE_VERSION,
    });
  });

  it('falls through authored-rich to default when mutationRate > 5', () => {
    const metrics: PageMetrics = { ...baseMetrics, authoredColorCount: 12, mutationRate: 6 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'default',
      reasons: [],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects opaque-styles when unreadableStylesheetRatio >= 0.5', () => {
    const metrics: PageMetrics = { ...baseMetrics, unreadableStylesheetRatio: 0.5 };

    const plan = decideStrategies(metrics, 'auto');

    expect(plan.strategies).toEqual(['baseline', 'computedFallback']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'opaque-styles',
      reasons: [{ metric: 'unreadableStylesheetRatio', value: 0.5, condition: { gte: 0.5 } }],
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

  it('boundary: colorCustomPropertyCount 8 selects calm-variables-rich, 7 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 8 }, 'auto');
    const belowBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 7 }, 'auto');

    expect(atBoundary.strategies).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(belowBoundary.strategies).toEqual(['baseline']);
  });

  it('boundary: authoredColorCount 12 selects authored-rich, 11 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, authoredColorCount: 12 }, 'auto');
    const belowBoundary = decideStrategies({ ...baseMetrics, authoredColorCount: 11 }, 'auto');

    expect(atBoundary.strategies).toEqual(['baseline', 'authoredRemap']);
    expect(belowBoundary.strategies).toEqual(['baseline']);
  });

  it('boundary: mutationRate 5 keeps calm-variables-rich, 6 drops to variables-capable', () => {
    const atBoundary = decideStrategies(
      { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 5 },
      'auto',
    );
    const aboveBoundary = decideStrategies(
      { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 6 },
      'auto',
    );

    expect(atBoundary.strategies).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(aboveBoundary.strategies).toEqual(['baseline', 'variableRemap']);
  });

  it('boundary: unreadableStylesheetRatio 0.5 selects opaque-styles, 0.49 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, unreadableStylesheetRatio: 0.5 }, 'auto');
    const belowBoundary = decideStrategies(
      { ...baseMetrics, unreadableStylesheetRatio: 0.49 },
      'auto',
    );

    expect(atBoundary.strategies).toEqual(['baseline', 'computedFallback']);
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
