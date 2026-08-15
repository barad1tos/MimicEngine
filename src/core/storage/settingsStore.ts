import { browser } from 'wxt/browser';
import { isStrategyId, type StrategyId } from '../engine/strategyId';
import { DEFAULT_THEME_ID, THEME_TOKEN_NAMES, type ThemeTokenName } from '../themes';

export type SiteOverride = {
  selector: string;
  property: string;
  token: ThemeTokenName;
};

export type SiteSettings = {
  enabled: boolean;
  themeId: string;
  strategy: 'auto' | StrategyId;
  preserveImages: boolean;
  preserveBrandColors: boolean;
  overrides: SiteOverride[];
};

export type AppSettings = {
  schemaVersion: 2;
  globalThemeId: string;
  sites: Record<string, SiteSettings>;
};

export const STORAGE_KEY = 'palette-mimicry:settings';

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 2,
  globalThemeId: DEFAULT_THEME_ID,
  sites: {},
};

export function createDefaultSiteSettings(themeId = DEFAULT_THEME_ID): SiteSettings {
  return {
    enabled: true,
    themeId,
    strategy: 'auto',
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
    if (areaName === 'local' && Object.hasOwn(changes, STORAGE_KEY)) {
      callback();
    }
  };

  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}

export function normalizeSettings(value: unknown): AppSettings {
  if (!isObject(value)) return DEFAULT_SETTINGS;

  const globalThemeId =
    typeof value.globalThemeId === 'string' ? value.globalThemeId : DEFAULT_THEME_ID;
  const sites = isObject(value.sites) ? normalizeSites(value.sites, globalThemeId) : {};

  return { schemaVersion: 2, globalThemeId, sites };
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
      themeId:
        typeof rawSiteSettings.themeId === 'string' ? rawSiteSettings.themeId : fallbackThemeId,
      ...resolveEnabledAndStrategy(rawSiteSettings),
      preserveImages:
        typeof rawSiteSettings.preserveImages === 'boolean' ? rawSiteSettings.preserveImages : true,
      preserveBrandColors:
        typeof rawSiteSettings.preserveBrandColors === 'boolean'
          ? rawSiteSettings.preserveBrandColors
          : true,
      overrides: normalizeOverrides(rawSiteSettings.overrides),
    };
  }

  return sites;
}

// Migrates legacy v1 `mode` sites (basic/semantic/aggressive/off) to v2 `strategy`.
// A v2 `strategy` value (valid StrategyId or 'auto') always takes precedence and
// passes through unchanged; otherwise a legacy `mode: 'off'` forces enabled:false,
// and any other/missing mode falls back to strategy:'auto' with enabled read from
// the stored boolean (default true). Invalid strategy strings also land here.
function resolveEnabledAndStrategy(
  rawSiteSettings: Record<string, unknown>,
): Pick<SiteSettings, 'enabled' | 'strategy'> {
  const rawStrategy = rawSiteSettings.strategy;
  const rawEnabled = typeof rawSiteSettings.enabled === 'boolean' ? rawSiteSettings.enabled : true;

  if (rawStrategy === 'auto' || isStrategyId(rawStrategy)) {
    return { enabled: rawEnabled, strategy: rawStrategy };
  }

  if (rawSiteSettings.mode === 'off') {
    return { enabled: false, strategy: 'auto' };
  }

  return { enabled: rawEnabled, strategy: 'auto' };
}

function normalizeOverrides(value: unknown): SiteOverride[] {
  if (!Array.isArray(value)) return [];

  const overrides: SiteOverride[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    if (typeof entry.selector !== 'string' || entry.selector.length === 0) continue;
    if (typeof entry.property !== 'string' || entry.property.length === 0) continue;
    if (!isThemeTokenName(entry.token)) continue;

    overrides.push({ selector: entry.selector, property: entry.property, token: entry.token });
  }

  return overrides;
}

function isThemeTokenName(value: unknown): value is ThemeTokenName {
  return typeof value === 'string' && (THEME_TOKEN_NAMES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
