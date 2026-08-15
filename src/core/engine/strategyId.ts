export const STRATEGY_IDS = [
  'baseline',
  'variableRemap',
  'authoredRemap',
  'computedFallback',
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && (STRATEGY_IDS as readonly string[]).includes(value);
}
