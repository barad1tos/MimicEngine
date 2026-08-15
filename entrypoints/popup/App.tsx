import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  planStrategies,
  type PlanReason,
  type StrategyPlan,
} from '@/src/core/engine/decisionTable';
import {
  planStorageKey,
  readPlanDiagnostics,
  type PlanDiagnostics,
} from '@/src/core/engine/diagnostics';
import { strategyRegistry } from '@/src/core/engine/registry';
import type { StrategyId } from '@/src/core/engine/strategyId';
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

const strategyOptions: { value: SiteSettings['strategy']; label: string }[] = [
  { value: 'auto', label: 'Auto (recommended)' },
  ...strategyRegistry.map((engine) => ({ value: engine.id, label: engine.label })),
];

const strategyLabelById = new Map(strategyRegistry.map((engine) => [engine.id, engine.label]));

function getStrategyLabel(id: StrategyId): string {
  return strategyLabelById.get(id) ?? id;
}

function formatReason(reason: PlanReason): string {
  const comparisons: string[] = [];
  if (reason.condition.gte !== undefined) comparisons.push(`≥ ${String(reason.condition.gte)}`);
  if (reason.condition.lte !== undefined) comparisons.push(`≤ ${String(reason.condition.lte)}`);
  return [reason.metric, reason.value, ...comparisons].join(' ');
}

function ProvenanceDetails({ provenance }: Readonly<{ provenance: StrategyPlan['provenance'] }>) {
  if (provenance.kind === 'manual') {
    return <p className="diagnostics-provenance">Manual override</p>;
  }

  return (
    <div className="diagnostics-provenance">
      <p className="diagnostics-rule">{provenance.rule}</p>
      {provenance.reasons.map((reason) => (
        <p key={reason.metric} className="diagnostics-reason">
          {formatReason(reason)}
        </p>
      ))}
      <p className="diagnostics-table-version">table v{provenance.tableVersion}</p>
    </div>
  );
}

function PlanDiagnosticsPanel({ diagnostics }: Readonly<{ diagnostics: PlanDiagnostics | null }>) {
  if (!diagnostics) {
    return (
      <section className="panel diagnostics">
        <p className="diagnostics-empty">No plan yet — open the site tab</p>
      </section>
    );
  }

  return (
    <section className="panel diagnostics">
      <div className="chip-row">
        {planStrategies(diagnostics.plan).map((id) => (
          <span key={id} className="chip">
            {getStrategyLabel(id)}
          </span>
        ))}
      </div>
      <ProvenanceDetails provenance={diagnostics.plan.provenance} />
      {diagnostics.coverage && (
        <p className="diagnostics-reason">
          Coverage: {diagnostics.coverage.mapped}/{diagnostics.coverage.discovered} colors (
          {Math.round(diagnostics.coverage.ratio * 100)}%)
        </p>
      )}
    </section>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');
  const [diagnostics, setDiagnostics] = useState<PlanDiagnostics | null>(null);

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

  useEffect(() => {
    let isMounted = true;

    async function loadDiagnostics(): Promise<void> {
      const result = siteKey === null ? null : await readPlanDiagnostics(siteKey);
      if (isMounted) setDiagnostics(result);
    }

    loadDiagnostics().catch((error: unknown) => {
      console.error('[Palette Mimicry] failed to load plan diagnostics', error);
    });

    return () => {
      isMounted = false;
    };
  }, [siteKey, settings]);

  useEffect(() => {
    if (siteKey === null) return;

    const key = planStorageKey(siteKey);
    const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
      if (areaName !== 'session') return;
      const change = changes[key];
      if (change === undefined) return;
      setDiagnostics((change.newValue as PlanDiagnostics | undefined) ?? null);
    };

    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }, [siteKey]);

  const siteSettings = useMemo(() => {
    if (!siteKey) return null;
    return settings.sites[siteKey] ?? createDefaultSiteSettings(settings.globalThemeId);
  }, [settings, siteKey]);

  const persist = async (nextSettings: AppSettings): Promise<void> => {
    setSettings(nextSettings);
    try {
      await saveSettings(nextSettings);
      setStatus('Saved');
    } catch (error) {
      console.error('[Palette Mimicry] failed to save settings', error);
      setStatus('Save failed');
    }
  };

  const updateGlobalTheme = async (themeId: string): Promise<void> => {
    await persist({ ...settings, globalThemeId: themeId });
  };

  const updateSite = async (patch: Partial<SiteSettings>): Promise<void> => {
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
  };

  const resetSite = async (): Promise<void> => {
    if (!siteKey) return;
    const remainingSites = Object.fromEntries(
      Object.entries(settings.sites).filter(([key]) => key !== siteKey),
    );
    await persist({ ...settings, sites: remainingSites });
  };

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
            <span>Strategy</span>
            <select
              value={siteSettings.strategy}
              onChange={(event) =>
                updateSite({ strategy: event.target.value as SiteSettings['strategy'] })
              }
              disabled={!siteSettings.enabled}
            >
              {strategyOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
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

      <PlanDiagnosticsPanel diagnostics={diagnostics} />

      <footer>{status}</footer>
    </main>
  );
}
