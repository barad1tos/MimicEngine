import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { builtInThemes } from '@/src/core/themes';
import {
  type AppSettings,
  type SiteSettings,
  DEFAULT_SETTINGS,
  createDefaultSiteSettings,
  getSettings,
  saveSettings,
} from '@/src/core/storage/settingsStore';
import { getSiteKeyFromUrl } from '@/src/core/storage/siteKey';

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');

  useEffect(() => {
    let isMounted = true;

    async function load() {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      const nextSiteKey = activeTab?.url ? getSiteKeyFromUrl(activeTab.url) : null;
      const nextSettings = await getSettings();

      if (!isMounted) return;
      setSiteKey(nextSiteKey);
      setSettings(nextSettings);
      setStatus(nextSiteKey ? 'Ready' : 'No page domain detected');
    }

    load().catch((error: unknown) => {
      console.error(error);
      if (isMounted) setStatus('Could not load settings');
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const siteSettings = useMemo(() => {
    if (!siteKey) return null;
    return settings.sites[siteKey] ?? createDefaultSiteSettings(settings.globalThemeId);
  }, [settings, siteKey]);

  async function persist(nextSettings: AppSettings) {
    setSettings(nextSettings);
    try {
      await saveSettings(nextSettings);
      setStatus('Saved');
    } catch (error) {
      console.error('[Palette Mimicry] failed to save settings', error);
      setStatus('Save failed');
    }
  }

  async function updateGlobalTheme(themeId: string) {
    await persist({ ...settings, globalThemeId: themeId });
  }

  async function updateSite(patch: Partial<SiteSettings>) {
    if (!siteKey) return;
    const current = settings.sites[siteKey] ?? createDefaultSiteSettings(settings.globalThemeId);
    await persist({
      ...settings,
      sites: {
        ...settings.sites,
        [siteKey]: {
          ...current,
          ...patch,
        },
      },
    });
  }

  async function resetSite() {
    if (!siteKey) return;
    const { [siteKey]: _removed, ...remainingSites } = settings.sites;
    await persist({ ...settings, sites: remainingSites });
  }

  return (
    <main className="popup-shell">
      <header>
        <p className="eyebrow">Palette Mimicry</p>
        <h1>Theme remapper</h1>
      </header>

      <section className="panel">
        <label className="field">
          <span>Current domain</span>
          <input value={siteKey ?? 'Unsupported page'} readOnly />
        </label>

        <label className="field">
          <span>Global theme</span>
          <select
            value={settings.globalThemeId}
            onChange={(event) => updateGlobalTheme(event.target.value)}
          >
            {builtInThemes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {siteSettings ? (
        <section className="panel">
          <div className="row">
            <span>Enable on this domain</span>
            <input
              type="checkbox"
              checked={siteSettings.enabled}
              onChange={(event) => updateSite({ enabled: event.target.checked })}
            />
          </div>

          <label className="field">
            <span>Site theme</span>
            <select
              value={siteSettings.themeId}
              onChange={(event) => updateSite({ themeId: event.target.value })}
              disabled={!siteSettings.enabled}
            >
              {builtInThemes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Mode</span>
            <select
              value={siteSettings.mode}
              onChange={(event) => updateSite({ mode: event.target.value as SiteSettings['mode'] })}
              disabled={!siteSettings.enabled}
            >
              <option value="basic">Basic</option>
              <option value="semantic">Semantic placeholder</option>
              <option value="aggressive">Aggressive placeholder</option>
              <option value="off">Off</option>
            </select>
          </label>

          <div className="row">
            <span>Preserve images/video/canvas</span>
            <input
              type="checkbox"
              checked={siteSettings.preserveImages}
              onChange={(event) => updateSite({ preserveImages: event.target.checked })}
            />
          </div>

          <div className="row">
            <span>Preserve brand colors</span>
            <input
              type="checkbox"
              checked={siteSettings.preserveBrandColors}
              onChange={(event) => updateSite({ preserveBrandColors: event.target.checked })}
            />
          </div>

          <button type="button" className="secondary" onClick={resetSite}>
            Reset domain settings
          </button>
        </section>
      ) : null}

      <footer>{status}</footer>
    </main>
  );
}
