import type { PageMetrics } from './pageMetrics';
import type { StrategyId, StrategySelection } from './strategyId';

export type MetricCondition = { gte?: number; lte?: number };

export type DecisionRow = {
  name: string;
  when: Partial<Record<keyof PageMetrics, MetricCondition>>;
  strategies: StrategyId[];
};

export const TABLE_VERSION = 3;

export const DECISION_TABLE: readonly DecisionRow[] = [
  {
    name: 'calm-variables-rich',
    when: { colorCustomPropertyCount: { gte: 8 }, mutationRate: { lte: 5 } },
    strategies: ['baseline', 'variableRemap', 'authoredRemap'],
  },
  {
    name: 'variables-capable',
    when: { colorCustomPropertyCount: { gte: 8 } },
    strategies: ['baseline', 'variableRemap'],
  },
  // Above authored-rich: a page can be both authored-color-rich AND largely
  // opaque-stylesheet (cross-origin sheets, CSP-blocked sheets, ...) at the
  // same time. Without this row, authored-rich's earlier table position
  // would win and the opaque-stylesheet signal — which authoredRemap alone
  // can't see into — would be silently dropped. mixed-visibility catches
  // that combination first and adds computedFallback to cover what
  // authoredRemap's readable-sheet analysis misses.
  {
    name: 'mixed-visibility',
    when: {
      authoredColorCount: { gte: 12 },
      unreadableStylesheetRatio: { gte: 0.5 },
      mutationRate: { lte: 5 },
    },
    strategies: ['baseline', 'authoredRemap', 'computedFallback'],
  },
  {
    name: 'authored-rich',
    when: { authoredColorCount: { gte: 12 }, mutationRate: { lte: 5 } },
    strategies: ['baseline', 'authoredRemap'],
  },
  {
    name: 'opaque-styles',
    when: { unreadableStylesheetRatio: { gte: 0.5 } },
    strategies: ['baseline', 'computedFallback'],
  },
  { name: 'default', when: {}, strategies: ['baseline'] },
];

export type PlanReason = { metric: keyof PageMetrics; value: number; condition: MetricCondition };

export type StrategyPlan = {
  provenance:
    | {
        kind: 'auto';
        rule: string;
        strategies: StrategyId[];
        reasons: PlanReason[];
        tableVersion: number;
      }
    | { kind: 'manual'; strategy: StrategyId };
};

// The strategies a plan selects, regardless of provenance: an auto plan's
// table-chosen list, or a manual override's single strategy wrapped in one.
export function planStrategies(plan: StrategyPlan): StrategyId[] {
  return plan.provenance.kind === 'manual'
    ? [plan.provenance.strategy]
    : plan.provenance.strategies;
}

function conditionHolds(value: number, condition: MetricCondition): boolean {
  if (condition.gte !== undefined && value < condition.gte) return false;
  return condition.lte === undefined || value <= condition.lte;
}

function matchReasons(row: DecisionRow, metrics: PageMetrics): PlanReason[] | null {
  const reasons: PlanReason[] = [];
  const entries = Object.entries(row.when) as [keyof PageMetrics, MetricCondition][];

  for (const [metric, condition] of entries) {
    const value = metrics[metric];
    if (!conditionHolds(value, condition)) return null;
    reasons.push({ metric, value, condition });
  }

  return reasons;
}

export function decideStrategies(metrics: PageMetrics, override: StrategySelection): StrategyPlan {
  if (override !== 'auto') {
    return { provenance: { kind: 'manual', strategy: override } };
  }

  for (const row of DECISION_TABLE) {
    const reasons = matchReasons(row, metrics);
    if (reasons === null) continue;

    return {
      provenance: {
        kind: 'auto',
        rule: row.name,
        strategies: row.strategies,
        reasons,
        tableVersion: TABLE_VERSION,
      },
    };
  }

  throw new Error('decisionTable: no row matched — the default row must have when: {}');
}
