import { buildBaseStylesheet } from '../../injector/buildBaseStylesheet';
import type { PaletteEngine } from '../registry';

export const baseline: PaletteEngine = {
  id: 'baseline',
  label: 'Base stylesheet',
  produce(theme) {
    return { css: buildBaseStylesheet(theme) };
  },
};
