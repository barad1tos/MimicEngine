import { describe, expect, it } from 'vitest';
import { DECISION_TABLE, TABLE_VERSION, decideStrategies, planStrategies } from './decisionTable';
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

    expect(planStrategies(plan)).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'calm-variables-rich',
      strategies: ['baseline', 'variableRemap', 'authoredRemap'],
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

    expect(planStrategies(plan)).toEqual(['baseline', 'variableRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'variables-capable',
      strategies: ['baseline', 'variableRemap'],
      reasons: [{ metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } }],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects authored-rich when authoredColorCount >= 12 and mutationRate <= 5', () => {
    const metrics: PageMetrics = { ...baseMetrics, authoredColorCount: 12, mutationRate: 5 };

    const plan = decideStrategies(metrics, 'auto');

    expect(planStrategies(plan)).toEqual(['baseline', 'authoredRemap']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'authored-rich',
      strategies: ['baseline', 'authoredRemap'],
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

    expect(planStrategies(plan)).toEqual(['baseline']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'default',
      strategies: ['baseline'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects opaque-styles when unreadableStylesheetRatio >= 0.5', () => {
    const metrics: PageMetrics = { ...baseMetrics, unreadableStylesheetRatio: 0.5 };

    const plan = decideStrategies(metrics, 'auto');

    expect(planStrategies(plan)).toEqual(['baseline', 'computedFallback']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'opaque-styles',
      strategies: ['baseline', 'computedFallback'],
      reasons: [{ metric: 'unreadableStylesheetRatio', value: 0.5, condition: { gte: 0.5 } }],
      tableVersion: TABLE_VERSION,
    });
  });

  it('falls through to default when no other row matches', () => {
    const plan = decideStrategies(baseMetrics, 'auto');

    expect(planStrategies(plan)).toEqual(['baseline']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'default',
      strategies: ['baseline'],
      reasons: [],
      tableVersion: TABLE_VERSION,
    });
  });

  it('selects style-starved only for a large DOM with at most three authored colors', () => {
    const styleStarvedPlan = decideStrategies(
      { ...baseMetrics, authoredColorCount: 3, domElementCount: 1500 },
      'auto',
    );
    const authoredBoundaryPlan = decideStrategies(
      { ...baseMetrics, authoredColorCount: 4, domElementCount: 1500 },
      'auto',
    );
    const domBoundaryPlan = decideStrategies(
      { ...baseMetrics, authoredColorCount: 3, domElementCount: 1499 },
      'auto',
    );

    expect(planStrategies(styleStarvedPlan)).toEqual(['baseline', 'computedFallback']);
    expect(styleStarvedPlan.provenance).toEqual({
      kind: 'auto',
      rule: 'style-starved',
      strategies: ['baseline', 'computedFallback'],
      reasons: [
        { metric: 'authoredColorCount', value: 3, condition: { lte: 3 } },
        { metric: 'domElementCount', value: 1500, condition: { gte: 1500 } },
      ],
      tableVersion: TABLE_VERSION,
    });
    expect(planStrategies(authoredBoundaryPlan)).toEqual(['baseline']);
    expect(planStrategies(domBoundaryPlan)).toEqual(['baseline']);
  });

  it('boundary: colorCustomPropertyCount 8 selects calm-variables-rich, 7 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 8 }, 'auto');
    const belowBoundary = decideStrategies({ ...baseMetrics, colorCustomPropertyCount: 7 }, 'auto');

    expect(planStrategies(atBoundary)).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(planStrategies(belowBoundary)).toEqual(['baseline']);
  });

  it('boundary: authoredColorCount 12 selects authored-rich, 11 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, authoredColorCount: 12 }, 'auto');
    const belowBoundary = decideStrategies({ ...baseMetrics, authoredColorCount: 11 }, 'auto');

    expect(planStrategies(atBoundary)).toEqual(['baseline', 'authoredRemap']);
    expect(planStrategies(belowBoundary)).toEqual(['baseline']);
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

    expect(planStrategies(atBoundary)).toEqual(['baseline', 'variableRemap', 'authoredRemap']);
    expect(planStrategies(aboveBoundary)).toEqual(['baseline', 'variableRemap']);
  });

  it('boundary: unreadableStylesheetRatio 0.5 selects opaque-styles, 0.49 falls through to default', () => {
    const atBoundary = decideStrategies({ ...baseMetrics, unreadableStylesheetRatio: 0.5 }, 'auto');
    const belowBoundary = decideStrategies(
      { ...baseMetrics, unreadableStylesheetRatio: 0.49 },
      'auto',
    );

    expect(planStrategies(atBoundary)).toEqual(['baseline', 'computedFallback']);
    expect(planStrategies(belowBoundary)).toEqual(['baseline']);
  });

  it('manual override bypasses the table entirely — only deepRemap composes (see deepRemap autonomy below)', () => {
    const plan = decideStrategies(baseMetrics, 'variableRemap');

    expect(plan).toEqual({
      provenance: { kind: 'manual', strategy: 'variableRemap' },
    });
    expect(planStrategies(plan)).toEqual(['variableRemap']);
  });

  it('the table is total: the last row matches unconditionally', () => {
    expect(DECISION_TABLE.at(-1)?.when).toEqual({});
  });

  it('selects mixed-visibility when authored-rich and opaque-styles conditions both hold — row priority over a non-adjacent conflicting row', () => {
    // authoredColorCount >= 12 alone would satisfy authored-rich (a lower-
    // priority row further down the table); unreadableStylesheetRatio >= 0.5
    // alone would satisfy opaque-styles. mixed-visibility sits above both and
    // requires all three conditions together, so it must win here — a page
    // that is both authored-color-rich and largely opaque-stylesheet must not
    // silently lose the opaque-stylesheet signal to authored-rich's earlier
    // (pre-mixed-visibility) table position.
    const metrics: PageMetrics = {
      ...baseMetrics,
      authoredColorCount: 12,
      unreadableStylesheetRatio: 0.5,
      mutationRate: 5,
    };

    const plan = decideStrategies(metrics, 'auto');

    expect(planStrategies(plan)).toEqual(['baseline', 'authoredRemap', 'computedFallback']);
    expect(plan.provenance).toEqual({
      kind: 'auto',
      rule: 'mixed-visibility',
      strategies: ['baseline', 'authoredRemap', 'computedFallback'],
      reasons: [
        { metric: 'authoredColorCount', value: 12, condition: { gte: 12 } },
        { metric: 'unreadableStylesheetRatio', value: 0.5, condition: { gte: 0.5 } },
        { metric: 'mutationRate', value: 5, condition: { lte: 5 } },
      ],
      tableVersion: TABLE_VERSION,
    });
  });

  it('boundary: mixed-visibility requires ALL three conditions — dropping any one falls through to authored-rich or opaque-styles', () => {
    const missingOpaque = decideStrategies(
      { ...baseMetrics, authoredColorCount: 12, mutationRate: 5 },
      'auto',
    );
    const missingAuthoredCount = decideStrategies(
      { ...baseMetrics, unreadableStylesheetRatio: 0.5, mutationRate: 5 },
      'auto',
    );
    // mutationRate above the row's own threshold disqualifies mixed-visibility
    // AND authored-rich (both require mutationRate <= 5); opaque-styles has
    // no mutationRate condition, so it still matches on unreadableStylesheetRatio.
    const missingCalmMutation = decideStrategies(
      { ...baseMetrics, authoredColorCount: 12, unreadableStylesheetRatio: 0.5, mutationRate: 6 },
      'auto',
    );

    expect(planStrategies(missingOpaque)).toEqual(['baseline', 'authoredRemap']);
    expect(planStrategies(missingAuthoredCount)).toEqual(['baseline', 'computedFallback']);
    expect(planStrategies(missingCalmMutation)).toEqual(['baseline', 'computedFallback']);
  });

  describe('deepRemap autonomy', () => {
    // deepRemap is manual-only: no table row may ever select it for a site
    // the user hasn't explicitly opted in — a structural check on the table
    // data itself, independent of decideStrategies' matching logic, so it
    // fails the moment anyone adds 'deepRemap' to a row's strategies list.
    it('no DECISION_TABLE row includes deepRemap', () => {
      expect(DECISION_TABLE.every((row) => !row.strategies.includes('deepRemap'))).toBe(true);
    });

    it('auto mode never yields deepRemap across every table-row fixture', () => {
      const tableRowFixtures: PageMetrics[] = [
        { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 5 }, // calm-variables-rich
        { ...baseMetrics, colorCustomPropertyCount: 8, mutationRate: 6 }, // variables-capable
        {
          ...baseMetrics,
          authoredColorCount: 12,
          unreadableStylesheetRatio: 0.5,
          mutationRate: 5,
        }, // mixed-visibility
        { ...baseMetrics, authoredColorCount: 12, mutationRate: 5 }, // authored-rich
        { ...baseMetrics, unreadableStylesheetRatio: 0.5 }, // opaque-styles
        { ...baseMetrics, authoredColorCount: 3, domElementCount: 1500 }, // style-starved
        baseMetrics, // default
      ];

      for (const metrics of tableRowFixtures) {
        const plan = decideStrategies(metrics, 'auto');
        expect(planStrategies(plan)).not.toContain('deepRemap');
      }
    });

    // Dynamic+ semantics (docs spec §3): deepRemap is an additive layer,
    // meaningless standalone — picking it composes it on top of whatever
    // row would have auto-matched these metrics, rather than replacing the
    // auto plan with deepRemap alone.
    it('manual override to deepRemap composes on the auto-matched row for those metrics', () => {
      const plan = decideStrategies(baseMetrics, 'deepRemap');

      expect(plan).toEqual({
        provenance: {
          kind: 'manual',
          strategy: 'deepRemap',
          composed: { rule: 'default', strategies: ['baseline'], tableVersion: TABLE_VERSION },
        },
      });
      expect(planStrategies(plan)).toEqual(['baseline', 'deepRemap']);
    });

    it('composes on different auto rows for different metric fixtures, deterministically', () => {
      const defaultMetrics = baseMetrics;
      const calmVariablesRichMetrics: PageMetrics = {
        ...baseMetrics,
        colorCustomPropertyCount: 8,
        mutationRate: 5,
      };

      const defaultPlan = decideStrategies(defaultMetrics, 'deepRemap');
      const richPlan = decideStrategies(calmVariablesRichMetrics, 'deepRemap');

      expect(planStrategies(defaultPlan)).toEqual(['baseline', 'deepRemap']);
      expect(planStrategies(richPlan)).toEqual([
        'baseline',
        'variableRemap',
        'authoredRemap',
        'deepRemap',
      ]);

      // Deterministic: same metrics -> byte-for-byte identical composed plan.
      expect(decideStrategies(calmVariablesRichMetrics, 'deepRemap')).toEqual(richPlan);
    });
  });
});
