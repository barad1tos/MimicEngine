import type { PaletteEngine, StrategyOutput } from '../engine/registry';
import { emitStylePlan } from '../engine/stylePlan';

type RenderedOutput = StrategyOutput & { css: string };

type RenderedEngine = Omit<PaletteEngine, 'produce'> & {
  produce(...parameters: Parameters<PaletteEngine['produce']>): RenderedOutput;
};

export function renderStrategy(engine: PaletteEngine): RenderedEngine {
  return {
    ...engine,
    produce(...parameters) {
      const output = engine.produce(...parameters);
      return { ...output, css: emitStylePlan({ sections: [output] }).css };
    },
  };
}
