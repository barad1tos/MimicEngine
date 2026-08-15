import { buildBaseStylesheet } from '../../injector/buildBaseStylesheet';
import type { PaletteEngine } from '../registry';

export const baseline: PaletteEngine = {
  id: 'baseline',
  label: 'Base stylesheet',
  produceCss(theme) {
    return buildBaseStylesheet(theme);
  },
};
