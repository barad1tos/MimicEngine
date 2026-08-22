import { buildBaseStylesheet } from '../injector/buildBaseStylesheet';
import type { SiteSettings } from '../storage/settingsStore';
import type { PaletteTheme } from '../themes';
import { composeOverrideStylesheet } from './composeStylesheet';
import { tokenVariablesCss } from './tokenVariables';

export function buildBootstrapStylesheet(theme: PaletteTheme, siteSettings: SiteSettings): string {
  return [
    tokenVariablesCss(theme),
    buildBaseStylesheet(theme, { omitInteractiveFloor: true }),
    composeOverrideStylesheet(siteSettings.overrides),
  ]
    .filter((block) => block.length > 0)
    .join('\n\n')
    .trim();
}
