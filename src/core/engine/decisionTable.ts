import type { PageMetrics } from './pageMetrics';
import type { StrategyId } from './strategyId';

export type MetricCondition = { gte?: number; lte?: number };

export type DecisionRow = {
  name: string;
  when: Partial<Record<keyof PageMetrics, MetricCondition>>;
  strategies: StrategyId[];
};

export const TABLE_VERSION = 2;

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
  strategies: StrategyId[];
  provenance:
    | { kind: 'auto'; rule: string; reasons: PlanReason[]; tableVersion: number }
    | { kind: 'manual'; strategy: StrategyId };
};

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

export function decideStrategies(
  metrics: PageMetrics,
  override: 'auto' | StrategyId,
): StrategyPlan {
  if (override !== 'auto') {
    return { strategies: [override], provenance: { kind: 'manual', strategy: override } };
  }

  for (const row of DECISION_TABLE) {
    const reasons = matchReasons(row, metrics);
    if (reasons === null) continue;

    return {
      strategies: row.strategies,
      provenance: { kind: 'auto', rule: row.name, reasons, tableVersion: TABLE_VERSION },
    };
  }

  throw new Error('decisionTable: no row matched — the default row must have when: {}');
}
