import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  planStrategies,
  type PlanReason,
  type StrategyPlan,
} from '@/src/core/engine/decisionTable';
import {
  isPlanDiagnostics,
  planStorageKey,
  readPlanDiagnostics,
  type PlanDiagnostics,
} from '@/src/core/engine/diagnostics';
import { strategyRegistry } from '@/src/core/engine/registry';
import type { StrategyId } from '@/src/core/engine/strategyId';
import { builtInThemes } from '@/src/core/themes';
import {
  type ImportedTheme,
  IMPORTED_THEMES_KEY,
  normalizeImportedThemes,
  readImportedThemes,
} from '@/src/core/storage/importedThemesStore';
import {
  type AppSettings,
  type SiteSettings,
  DEFAULT_SETTINGS,
  deriveEffectiveSiteSettings,
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
    return (
      <p className="diagnostics-provenance">
        {provenance.composed
          ? `Manual override · composed on ${provenance.composed.rule}`
          : 'Manual override'}
      </p>
    );
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
      {diagnostics.census && !diagnostics.census.complete && (
        <p className="diagnostics-reason">
          Census in progress — {diagnostics.census.signatureCount} signatures /{' '}
          {diagnostics.census.elementsVisited} elements
        </p>
      )}
      {diagnostics.census && diagnostics.census.droppedProperties > 0 && (
        <p className="diagnostics-reason">
          {diagnostics.census.droppedProperties} properties dropped as ambiguous
        </p>
      )}
    </section>
  );
}

function ThemeOptions({ importedThemes }: Readonly<{ importedThemes: ImportedTheme[] }>) {
  return (
    <>
      <optgroup label="Built-in">
        {builtInThemes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
      </optgroup>
      {importedThemes.length > 0 && (
        <optgroup label="Imported">
          {importedThemes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');
  const [diagnostics, setDiagnostics] = useState<PlanDiagnostics | null>(null);
  const [importedThemes, setImportedThemes] = useState<ImportedTheme[]>([]);
  // Guards against the load effect resolving after a fresher onChanged
  // update already landed: both paths capture their own sequence number
  // before doing async/event work and only commit if it's still current.
  const diagnosticsSeq = useRef(0);
  // Same last-write-wins discipline as diagnosticsSeq, scoped to the
  // imported-themes list: the mount-time load races the local-area
  // onChanged listener below, and a stale slow load must not clobber a
  // fresher onChanged refresh.
  const importedThemesSeq = useRef(0);

  useEffect(() => {
    let isMounted = true;
    const seq = ++importedThemesSeq.current;

    async function load() {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      const nextSiteKey = activeTab?.url ? getSiteKeyFromUrl(activeTab.url) : null;
      const [nextSettings, nextImportedThemes] = await Promise.all([
        getSettings(),
        readImportedThemes(),
      ]);

      if (!isMounted) return;
      setSiteKey(nextSiteKey);
      setSettings(nextSettings);
      if (seq === importedThemesSeq.current) setImportedThemes(nextImportedThemes);
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
    const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
      if (areaName !== 'local') return;
      const change = changes[IMPORTED_THEMES_KEY];
      if (change === undefined) return;
      const seq = ++importedThemesSeq.current;
      if (seq === importedThemesSeq.current) {
        setImportedThemes(normalizeImportedThemes(change.newValue).themes);
      }
    };

    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const seq = ++diagnosticsSeq.current;

    async function loadDiagnostics(): Promise<void> {
      const result = siteKey === null ? null : await readPlanDiagnostics(siteKey);
      if (isMounted && seq === diagnosticsSeq.current) setDiagnostics(result);
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
      const seq = ++diagnosticsSeq.current;
      if (seq === diagnosticsSeq.current) {
        setDiagnostics(isPlanDiagnostics(change.newValue) ? change.newValue : null);
      }
    };

    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }, [siteKey]);

  const siteSettings = useMemo(() => {
    if (!siteKey) return null;
    return deriveEffectiveSiteSettings(settings, siteKey);
  }, [settings, siteKey]);

  const persist = async (nextSettings: AppSettings): Promise<void> => {
    const previousSettings = settings;
    setSettings(nextSettings);
    try {
      await saveSettings(nextSettings);
      setStatus('Saved');
    } catch (error) {
      console.error('[Palette Mimicry] failed to save settings', error);
      // The optimistic update above never actually persisted — roll the UI
      // back to what's genuinely in storage rather than leaving it showing
      // a setting that silently failed to save.
      setSettings(previousSettings);
      setStatus('Save failed');
    }
  };

  const updateGlobalTheme = async (themeId: string): Promise<void> => {
    await persist({ ...settings, globalThemeId: themeId });
  };

  const updateSite = async (patch: Partial<SiteSettings>): Promise<void> => {
    if (!siteKey) return;
    const current = deriveEffectiveSiteSettings(settings, siteKey);
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

  const openOptionsPage = (): void => {
    browser.runtime.openOptionsPage().catch((error: unknown) => {
      console.error('[Palette Mimicry] failed to open options page', error);
    });
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
            <ThemeOptions importedThemes={importedThemes} />
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
              <ThemeOptions importedThemes={importedThemes} />
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

      <footer>
        <span>{status}</span>
        <button
          type="button"
          className="icon-button"
          onClick={openOptionsPage}
          aria-label="Open options"
          title="Options"
        >
          ⚙
        </button>
      </footer>
    </main>
  );
}
