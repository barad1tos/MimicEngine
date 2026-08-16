export const STRATEGY_IDS = [
  'baseline',
  'variableRemap',
  'authoredRemap',
  'computedFallback',
  'deepRemap',
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

// The strategy a site can be configured to: either a specific engine, or
// 'auto' to let the decision table choose. Distinct from StrategyId, which
// never includes 'auto' — every place that persists or accepts user choice
// (settings, decideStrategies' override param) uses this type instead.
export type StrategySelection = 'auto' | StrategyId;

export function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && (STRATEGY_IDS as readonly string[]).includes(value);
}
