import { buildBaseStylesheet } from '../../injector/buildBaseStylesheet';
import { planStrategies } from '../decisionTable';
import type { PaletteEngine } from '../registry';

export const baseline: PaletteEngine = {
  id: 'baseline',
  label: 'Base stylesheet',
  // Amendment 2 (signature-census-design.md): the interactive-surface floor
  // yields to computedFallback whenever it's in the plan — the census
  // already paints exactly the surfaces genuinely opaque on the page, so the
  // floor's readability-net job (for pages we can't read at all) doesn't
  // apply. Every other baseline rule (canvas/text ground, etc.) is
  // unconditional either way.
  produce(theme, _siteSettings, _facts, plan) {
    const omitInteractiveFloor = planStrategies(plan).includes('computedFallback');
    return { css: buildBaseStylesheet(theme, { omitInteractiveFloor }) };
  },
};
