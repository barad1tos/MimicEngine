import { browser } from 'wxt/browser';
import { DEFAULT_THEME_ID, type ThemeTokenName } from '../themes';

export type ThemeMode = 'off' | 'basic' | 'semantic' | 'aggressive';

export type SiteOverride = {
  selector: string;
  property: string;
  token: ThemeTokenName;
};

export type SiteSettings = {
  enabled: boolean;
  themeId: string;
  mode: ThemeMode;
  preserveImages: boolean;
  preserveBrandColors: boolean;
  overrides: SiteOverride[];
};

export type AppSettings = {
  globalThemeId: string;
  sites: Record<string, SiteSettings>;
};

export const STORAGE_KEY = 'palette-mimicry:settings';

export const DEFAULT_SETTINGS: AppSettings = {
  globalThemeId: DEFAULT_THEME_ID,
  sites: {},
};

export function createDefaultSiteSettings(themeId = DEFAULT_THEME_ID): SiteSettings {
  return {
    enabled: true,
    themeId,
    mode: 'basic',
    preserveImages: true,
    preserveBrandColors: true,
    overrides: [],
  };
}

export async function getSettings(): Promise<AppSettings> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return normalizeSettings(result[STORAGE_KEY]);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: normalizeSettings(settings) });
}

export async function getEffectiveSiteSettings(siteKey: string): Promise<SiteSettings> {
  const settings = await getSettings();
  return settings.sites[siteKey] ?? createDefaultSiteSettings(settings.globalThemeId);
}

export function onSettingsChanged(callback: () => void): () => void {
  const listener = (changes: Record<string, unknown>, areaName: string) => {
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
      callback();
    }
  };

  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}

function normalizeSettings(value: unknown): AppSettings {
  if (!isObject(value)) return DEFAULT_SETTINGS;

  const globalThemeId =
    typeof value.globalThemeId === 'string' ? value.globalThemeId : DEFAULT_THEME_ID;
  const sites = isObject(value.sites) ? normalizeSites(value.sites, globalThemeId) : {};

  return { globalThemeId, sites };
}

function normalizeSites(
  value: Record<string, unknown>,
  fallbackThemeId: string,
): Record<string, SiteSettings> {
  const sites: Record<string, SiteSettings> = {};

  for (const [siteKey, rawSiteSettings] of Object.entries(value)) {
    if (!isObject(rawSiteSettings)) continue;

    sites[siteKey] = {
      ...createDefaultSiteSettings(fallbackThemeId),
      enabled: typeof rawSiteSettings.enabled === 'boolean' ? rawSiteSettings.enabled : true,
      themeId:
        typeof rawSiteSettings.themeId === 'string' ? rawSiteSettings.themeId : fallbackThemeId,
      mode: isThemeMode(rawSiteSettings.mode) ? rawSiteSettings.mode : 'basic',
      preserveImages:
        typeof rawSiteSettings.preserveImages === 'boolean' ? rawSiteSettings.preserveImages : true,
      preserveBrandColors:
        typeof rawSiteSettings.preserveBrandColors === 'boolean'
          ? rawSiteSettings.preserveBrandColors
          : true,
      overrides: Array.isArray(rawSiteSettings.overrides) ? [] : [],
    };
  }

  return sites;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'off' || value === 'basic' || value === 'semantic' || value === 'aggressive';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
