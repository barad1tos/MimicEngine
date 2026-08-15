import { describe, expect, it } from 'vitest';
import { strategyRegistry } from './registry';
import { STRATEGY_IDS } from './strategyId';

describe('strategyRegistry', () => {
  it('registers exactly the ids declared in STRATEGY_IDS, drift-free', () => {
    expect(strategyRegistry.map((engine) => engine.id)).toEqual([...STRATEGY_IDS]);
  });
});
