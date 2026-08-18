import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { connectHost, type HostSession } from '@/src/core/native/hostClient';
import type { HostError, HostFile } from '@/src/core/native/protocol';
import { splitScanPath } from '@/src/core/native/scanPath';
import {
  THEME_TOKEN_NAMES,
  type PaletteTheme,
  type ThemeTokenName,
  type ThemeTokens,
} from '@/src/core/themes';
import { importTheme } from '@/src/core/themes/import/importTheme';
import {
  FORMAT_DEFAULT_THEME_NAMES,
  type SourceFormatId,
} from '@/src/core/themes/import/importTypes';
import {
  detectPlatform,
  orderSourceCards,
  type SourceCard,
} from '@/src/core/themes/import/sourceCatalog';
import {
  type ImportedTheme,
  IMPORTED_THEMES_KEY,
  deleteImportedTheme,
  importedThemeId,
  normalizeImportedThemes,
  readImportedThemes,
  readRecentSources,
  saveImportedTheme,
  slugifyThemeName,
} from '@/src/core/storage/importedThemesStore';
import { getSettings, pruneThemeReferences, saveSettings } from '@/src/core/storage/settingsStore';

// The File System Access API (window.showOpenFilePicker) isn't in TypeScript's
// bundled lib.dom.d.ts yet, and this repo takes no new dependencies to pull in
// @types/wicg-file-system-access for one method. `declare global { interface
// Window {...} }` would need `interface` to merge with the ambient Window
// declaration, which this repo's lint config forbids outright (no per-line
// suppressions either). A local structural-facade type sidesteps interface
// merging entirely: `window` already satisfies it (the extra member is
// optional), no cast needed. FileSystemFileHandle itself IS already in
// lib.dom, so it needs no facade of its own.
type FilePickerAcceptType = {
  description: string;
  accept: Record<string, readonly string[]>;
};

type FilePickerOptions = {
  multiple: boolean;
  id: string;
  types?: readonly FilePickerAcceptType[];
};

type WindowWithFilePicker = Window & {
  showOpenFilePicker?: (options: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
};

function readFilePicker(
  win: WindowWithFilePicker,
): ((options: FilePickerOptions) => Promise<FileSystemFileHandle[]>) | undefined {
  return win.showOpenFilePicker;
}

// navigator.userAgentData (Chromium; unsupported in Firefox) isn't in this
// TS version's lib.dom.d.ts either -- same structural-facade treatment.
type NavigatorWithUserAgentData = Navigator & {
  readonly userAgentData?: { readonly platform: string };
};

// Firefox has no userAgentData, so navigator.platform (deprecated, but the
// only signal Firefox offers) stays as the fallback. Isolated behind its own
// facade type -- `{ readonly platform: string }`, not `Navigator` -- so this
// file's one unavoidable read of it doesn't resolve against Navigator's own
// (JSDoc @deprecated) declaration.
function legacyNavigatorPlatform(nav: { readonly platform: string }): string {
  return nav.platform;
}

function resolveNavigatorPlatform(nav: NavigatorWithUserAgentData): string {
  return nav.userAgentData?.platform ?? legacyNavigatorPlatform(nav);
}

const supportsFilePicker = 'showOpenFilePicker' in window;

type QueueSource =
  | { kind: 'file'; file: File; cardId: string }
  | { kind: 'paste'; content: string; cardId: string }
  // Read over the native host during a disk scan. `fileName` is the scanned
  // path's basename (see splitScanPath) -- the scan-flow analogue of a
  // `File` object's own `.name`, used the same way for nameless-theme seeding
  // below. Pasted content has no comparable source, hence no `fileName` there.
  | { kind: 'scan'; content: string; cardId: string; fileName: string };

type QueueEntry = { key: string; source: QueueSource };

type ImportBatch = { items: QueueEntry[]; index: number };

type ImportOutcome =
  | {
      kind: 'success';
      theme: PaletteTheme;
      sourceFormat: SourceFormatId;
      derivedTokens: readonly ThemeTokenName[];
    }
  | { kind: 'error'; message: string };

const EMPTY_BATCH: ImportBatch = { items: [], index: 0 };

// One `connectHost()` port for the page's whole lifetime once established --
// never reconnected per scan, never closed on queue completion (cheaper than
// reconnect-per-scan; see the pagehide effect below for the one place it's
// torn down). `error` keeps the failure reason around for the install-hint
// banner but is otherwise treated like `idle`: every card's button reverts
// to its unconnected label, so a retry after installing the host just works.
type HostConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; session: HostSession; close: () => void }
  | { kind: 'error'; error: HostError };

// Per-card scan-results state -- at most one card's scan is open at a time
// (opening a new one implicitly replaces the last), keyed by `cardId` so the
// panel renders under the right card.
type ScanState =
  | { cardId: string; phase: 'loading' }
  | { cardId: string; phase: 'ready'; files: readonly HostFile[]; selected: ReadonlySet<string> }
  | {
      cardId: string;
      phase: 'importing';
      files: readonly HostFile[];
      selected: ReadonlySet<string>;
    }
  | { cardId: string; phase: 'error'; message: string };

// What a source card's host-scan affordance should render, derived from the
// page-wide connection state plus that one card's id -- keeps SourceCardView
// itself free of connection-state branching (it just renders a status).
type CardHostStatus =
  | { kind: 'unconnected'; label: string }
  | { kind: 'connecting' }
  | { kind: 'scannable' }
  | { kind: 'unsupported' };

function deriveCardHostStatus(
  card: SourceCard,
  hostConnection: HostConnectionState,
  hasNativeMessagingPermission: boolean,
): CardHostStatus {
  if (hostConnection.kind === 'connecting') return { kind: 'connecting' };
  if (hostConnection.kind === 'connected') {
    return hostConnection.session.sourceIds.includes(card.id)
      ? { kind: 'scannable' }
      : { kind: 'unsupported' };
  }
  return {
    kind: 'unconnected',
    label: hasNativeMessagingPermission ? 'Connect' : 'Enable disk scan',
  };
}

/** The `file`/`scan` source basename FORMAT_DEFAULT_THEME_NAMES-seeding below
 * needs, or `null` for a source with no filename to seed from (pasted text). */
function queueSourceFileName(source: QueueSource): string | null {
  if (source.kind === 'file') return source.file.name;
  if (source.kind === 'scan') return source.fileName;
  return null;
}

function describeScanImportOutcome(importedCount: number, failedNames: readonly string[]): string {
  const parts: string[] = [];
  if (importedCount > 0) parts.push(`Imported ${String(importedCount)} file(s)`);
  if (failedNames.length > 0) parts.push(`failed: ${failedNames.join(', ')}`);
  return parts.join('; ');
}

/**
 * Strips a file name's final extension only -- `ayu-mirage.json` becomes
 * `ayu-mirage`, and a double extension like `ayu.theme.json` becomes
 * `ayu.theme` (only the last segment is stripped). A name with no `.` (or
 * a leading dot only, e.g. a hidden file) is returned unchanged.
 */
function basenameWithoutExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

function SwatchGrid({
  tokens,
  derivedTokens,
}: Readonly<{ tokens: ThemeTokens; derivedTokens: readonly ThemeTokenName[] }>) {
  const derivedSet = new Set(derivedTokens);
  return (
    <div className="swatch-grid">
      {THEME_TOKEN_NAMES.map((name) => (
        <div key={name} className="swatch">
          <span className="swatch-color" style={{ background: tokens[name] }} />
          <span className="swatch-name">{name}</span>
          <span className="swatch-hex">{tokens[name]}</span>
          {derivedSet.has(name) && <span className="badge">derived</span>}
        </div>
      ))}
    </div>
  );
}

function MiniSwatchStrip({ tokens }: Readonly<{ tokens: ThemeTokens }>) {
  return (
    <div className="mini-swatch-strip">
      {THEME_TOKEN_NAMES.map((name) => (
        <span key={name} className="mini-swatch" style={{ background: tokens[name] }} />
      ))}
    </div>
  );
}

function SourceCardPaths({
  card,
  paths,
  platform,
  onCopy,
}: Readonly<{
  card: SourceCard;
  paths: readonly string[];
  platform: ReturnType<typeof detectPlatform>;
  onCopy: (path: string) => void;
}>) {
  if (paths.length === 0) return null;

  return (
    <>
      <ul className="source-card-paths">
        {paths.map((path) => (
          <li key={path}>
            <code>{path}</code>
            <button
              type="button"
              className="icon-button"
              aria-label={`Copy ${card.label} path`}
              onClick={() => {
                onCopy(path);
              }}
            >
              Copy
            </button>
          </li>
        ))}
      </ul>
      {platform === 'mac' && (
        <p className="source-card-hint">Press ⌘⇧G in the dialog and paste the path.</p>
      )}
    </>
  );
}

function SourceCardHostRow({
  hostStatus,
  onEnableDiskScan,
  onScan,
}: Readonly<{
  hostStatus: CardHostStatus;
  onEnableDiskScan: () => Promise<void>;
  onScan: () => Promise<void>;
}>) {
  if (hostStatus.kind === 'connecting') {
    return <p className="source-card-hint">Connecting…</p>;
  }
  if (hostStatus.kind === 'unsupported') {
    return <p className="source-card-hint">Not scannable by this host version.</p>;
  }
  if (hostStatus.kind === 'scannable') {
    return (
      <button type="button" className="secondary" onClick={() => onScan()}>
        Scan
      </button>
    );
  }
  return (
    <button type="button" className="secondary" onClick={() => onEnableDiskScan()}>
      {hostStatus.label}
    </button>
  );
}

function ScanFileRow({
  file,
  checked,
  disabled,
  onToggle,
}: Readonly<{
  file: HostFile;
  checked: boolean;
  disabled: boolean;
  onToggle: (path: string) => void;
}>) {
  const { baseName, dirTail } = splitScanPath(file.path);
  const sizeLabel = `${(file.size / 1024).toFixed(1)} KB`;
  const modifiedLabel = new Date(file.modifiedAt).toLocaleDateString();

  return (
    <li className="scan-file-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => {
          onToggle(file.path);
        }}
      />
      <div className="scan-file-meta">
        <span className="scan-file-name">{baseName}</span>
        {dirTail.length > 0 && <span className="scan-file-dir">{dirTail}</span>}
      </div>
      <span className="scan-file-size">{sizeLabel}</span>
      <span className="scan-file-date">{modifiedLabel}</span>
    </li>
  );
}

function ScanPanel({
  state,
  onToggleFile,
  onToggleSelectAll,
  onImportSelected,
  onCancel,
}: Readonly<{
  state: ScanState;
  onToggleFile: (path: string) => void;
  onToggleSelectAll: () => void;
  onImportSelected: () => Promise<void>;
  onCancel: () => void;
}>) {
  if (state.phase === 'loading') {
    return <p className="source-card-hint">Scanning…</p>;
  }

  if (state.phase === 'error') {
    return (
      <div className="scan-panel">
        <p className="import-error">{state.message}</p>
        <button type="button" className="secondary" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  if (state.files.length === 0) {
    return (
      <div className="scan-panel">
        <p className="empty-hint">No files found.</p>
        <button type="button" className="secondary" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  const isImporting = state.phase === 'importing';
  const allSelected = state.selected.size === state.files.length;

  return (
    <div className="scan-panel">
      <label className="row">
        <span>Select all ({state.files.length.toString()})</span>
        <input
          type="checkbox"
          checked={allSelected}
          disabled={isImporting}
          onChange={onToggleSelectAll}
        />
      </label>
      <ul className="scan-file-list">
        {state.files.map((file) => (
          <ScanFileRow
            key={file.path}
            file={file}
            checked={state.selected.has(file.path)}
            disabled={isImporting}
            onToggle={onToggleFile}
          />
        ))}
      </ul>
      <div className="scan-panel-actions">
        <button
          type="button"
          disabled={isImporting || state.selected.size === 0}
          onClick={() => onImportSelected()}
        >
          {isImporting ? 'Importing…' : `Import selected (${state.selected.size.toString()})`}
        </button>
        <button type="button" className="secondary" disabled={isImporting} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SourceCardView({
  card,
  platform,
  onPick,
  onInputFiles,
  hostStatus,
  scanState,
  onEnableDiskScan,
  onScan,
  onToggleScanFile,
  onToggleSelectAllScanFiles,
  onImportSelectedScanFiles,
  onCancelScan,
}: Readonly<{
  card: SourceCard;
  platform: ReturnType<typeof detectPlatform>;
  onPick: (card: SourceCard) => Promise<void>;
  onInputFiles: (event: ChangeEvent<HTMLInputElement>, cardId: string) => void;
  hostStatus: CardHostStatus;
  scanState: ScanState | null;
  onEnableDiskScan: () => Promise<void>;
  onScan: (card: SourceCard) => Promise<void>;
  onToggleScanFile: (path: string) => void;
  onToggleSelectAllScanFiles: () => void;
  onImportSelectedScanFiles: () => Promise<void>;
  onCancelScan: () => void;
}>) {
  const paths = card.paths[platform] ?? [];
  const acceptAttribute =
    card.pickerExtensions.length > 0 ? card.pickerExtensions.join(',') : undefined;

  const handleCopy = (path: string): void => {
    navigator.clipboard.writeText(path).catch((error: unknown) => {
      console.error('[Palette Mimicry] failed to copy path', error);
    });
  };

  return (
    <div className="source-card">
      <div className="source-card-header">
        <span className="source-card-label">{card.label}</span>
        {supportsFilePicker ? (
          <button type="button" onClick={() => onPick(card)}>
            Browse…
          </button>
        ) : (
          <label className="file-input-label">
            Browse…
            <input
              type="file"
              multiple
              accept={acceptAttribute}
              onChange={(event) => {
                onInputFiles(event, card.id);
              }}
              hidden
            />
          </label>
        )}
      </div>
      <SourceCardPaths card={card} paths={paths} platform={platform} onCopy={handleCopy} />
      {card.instructions && <p className="source-card-instructions">{card.instructions}</p>}
      <div className="source-card-host-row">
        <SourceCardHostRow
          hostStatus={hostStatus}
          onEnableDiskScan={onEnableDiskScan}
          onScan={() => onScan(card)}
        />
      </div>
      {scanState?.cardId === card.id && (
        <ScanPanel
          state={scanState}
          onToggleFile={onToggleScanFile}
          onToggleSelectAll={onToggleSelectAllScanFiles}
          onImportSelected={onImportSelectedScanFiles}
          onCancel={onCancelScan}
        />
      )}
    </div>
  );
}

function ImportPreview({
  outcome,
  editedName,
  onEditedNameChange,
  setAsGlobal,
  onSetAsGlobalChange,
  saveLabel,
  saveDisabled,
  saveDisabledHint,
  isSaving,
  onSave,
  onSkip,
}: Readonly<{
  outcome: ImportOutcome;
  editedName: string;
  onEditedNameChange: (value: string) => void;
  setAsGlobal: boolean;
  onSetAsGlobalChange: (value: boolean) => void;
  saveLabel: string;
  saveDisabled: boolean;
  saveDisabledHint: string;
  isSaving: boolean;
  onSave: () => Promise<void>;
  onSkip: () => void;
}>) {
  if (outcome.kind === 'error') {
    return (
      <div className="import-preview">
        <p className="import-error">{outcome.message}</p>
        <button type="button" className="secondary" onClick={onSkip} disabled={isSaving}>
          Skip
        </button>
      </div>
    );
  }

  return (
    <form
      className="import-preview"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave();
      }}
    >
      <label className="field">
        <span>Theme name</span>
        <input
          value={editedName}
          onChange={(event) => {
            onEditedNameChange(event.target.value);
          }}
          autoFocus
        />
        {saveDisabled && <span className="field-hint">{saveDisabledHint}</span>}
      </label>

      <p className="import-meta">
        {outcome.theme.mode} · {outcome.sourceFormat}
      </p>

      <SwatchGrid tokens={outcome.theme.tokens} derivedTokens={outcome.derivedTokens} />

      <label className="row">
        <span>Set as global theme</span>
        <input
          type="checkbox"
          checked={setAsGlobal}
          onChange={(event) => {
            onSetAsGlobalChange(event.target.checked);
          }}
        />
      </label>

      <div className="import-preview-actions">
        <button type="submit" disabled={saveDisabled || isSaving}>
          {saveLabel}
        </button>
        <button type="button" className="secondary" onClick={onSkip} disabled={isSaving}>
          Skip
        </button>
      </div>
    </form>
  );
}

function ImportedThemeRow({
  theme,
  onDelete,
}: Readonly<{ theme: ImportedTheme; onDelete: (id: string) => Promise<void> }>) {
  return (
    <li className="imported-theme-row">
      <MiniSwatchStrip tokens={theme.tokens} />
      <div className="imported-theme-meta">
        <span className="imported-theme-name">{theme.name}</span>
        <span className="imported-theme-format">
          {theme.sourceFormat} · {theme.mode}
        </span>
      </div>
      <button type="button" className="secondary" onClick={() => onDelete(theme.id)}>
        Delete
      </button>
    </li>
  );
}

export function App() {
  const [importedThemes, setImportedThemes] = useState<ImportedTheme[]>([]);
  const [recentSources, setRecentSources] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [pasteText, setPasteText] = useState<string>('');
  const [batch, setBatch] = useState<ImportBatch>(EMPTY_BATCH);
  const [currentOutcome, setCurrentOutcome] = useState<ImportOutcome | null>(null);
  const [editedName, setEditedName] = useState<string>('');
  const [setAsGlobal, setSetAsGlobal] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [hasNativeMessagingPermission, setHasNativeMessagingPermission] = useState<boolean>(false);
  const [hostConnection, setHostConnectionState] = useState<HostConnectionState>({ kind: 'idle' });
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const queueKeySeq = useRef(0);
  // Mirrors `hostConnection` for the pagehide handler below, which is
  // registered once on mount and would otherwise close over the 'idle'
  // state from that first render forever.
  const hostConnectionRef = useRef<HostConnectionState>({ kind: 'idle' });
  // Tracks which card owns the in-flight scan/import work, guarding
  // handleScanCard's post-await setScanState calls AND
  // handleImportSelectedScanFiles's completion against a cross-card race:
  // click Scan on a slow card, then a different card, before the first
  // resolves. Set synchronously (before the relevant await) to the card
  // that most recently started a scan; a stale response or completion
  // only takes effect if it still matches. Deliberately a guard rather
  // than also disabling the other cards' Scan buttons while one is
  // loading/importing -- fewer moving parts in the UI, and the guard
  // alone is sufficient since a superseded response is simply dropped,
  // never rendered.
  const scanCardIdRef = useRef<string | null>(null);
  // Same last-write-wins discipline as the popup's T12 pattern: the mount-time
  // load races the local-area onChanged listener below, and a stale slow load
  // must not clobber a fresher onChanged refresh.
  const importedThemesSeq = useRef(0);

  const platform = detectPlatform(resolveNavigatorPlatform(navigator));
  const orderedCards = orderSourceCards(recentSources, platform);

  const setHostConnection = (next: HostConnectionState): void => {
    hostConnectionRef.current = next;
    setHostConnectionState(next);
  };

  // Mount-time behavior is deliberately passive: `permissions.contains`
  // never prompts (unlike `permissions.request`), so this only decides the
  // unconnected button's label ('Connect' vs 'Enable disk scan'). It does
  // NOT connect to the host even when permission is already granted --
  // that only happens lazily, on the first Enable/Scan click, so a page
  // visit that never touches disk scan spawns zero host processes.
  useEffect(() => {
    let isMounted = true;
    browser.permissions
      .contains({ permissions: ['nativeMessaging'] })
      .then((granted) => {
        if (isMounted) setHasNativeMessagingPermission(granted);
      })
      .catch((error: unknown) => {
        console.error('[Palette Mimicry] failed to check nativeMessaging permission', error);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  // The host session outlives any single scan -- reused across every card a
  // visit scans -- and is torn down only here, on pagehide, never on queue
  // completion (cheaper than reconnecting per scan). Registered once; reads
  // the live connection through the ref so a session opened well after mount
  // still gets closed.
  useEffect(() => {
    const handlePageHide = (): void => {
      const current = hostConnectionRef.current;
      if (current.kind === 'connected') current.close();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const seq = ++importedThemesSeq.current;

    async function load(): Promise<void> {
      const [themes, sources] = await Promise.all([readImportedThemes(), readRecentSources()]);
      if (!isMounted) return;
      if (seq === importedThemesSeq.current) {
        setImportedThemes(themes);
        setRecentSources(sources);
      }
    }

    load().catch((error: unknown) => {
      console.error('[Palette Mimicry] failed to load imported themes', error);
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
        const normalized = normalizeImportedThemes(change.newValue);
        setImportedThemes(normalized.themes);
        setRecentSources(normalized.recentSources);
      }
    };

    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    const entry = batch.items[batch.index];
    if (!entry || currentOutcome !== null) return;
    let cancelled = false;

    async function resolve(currentEntry: QueueEntry): Promise<void> {
      const content =
        currentEntry.source.kind === 'file'
          ? await currentEntry.source.file.text()
          : currentEntry.source.content;
      if (cancelled) return;

      const result = importTheme(content);
      if (result.ok) {
        setCurrentOutcome({
          kind: 'success',
          theme: result.theme,
          sourceFormat: result.sourceFormat,
          derivedTokens: result.derivedTokens,
        });
        // A picked/dropped/scanned file whose adapter produced a
        // format-default name (no name of its own) seeds a stronger name
        // from the file's basename instead, so two nameless imports don't
        // collide on the same slug and silently replace one another. Pasted
        // content has no filename, so it keeps the format default (the
        // Replace-labeled save button still makes a same-name collision
        // explicit there).
        const fileBaseName = queueSourceFileName(currentEntry.source);
        const seedName =
          fileBaseName !== null && FORMAT_DEFAULT_THEME_NAMES.has(result.theme.name)
            ? basenameWithoutExtension(fileBaseName)
            : result.theme.name;
        setEditedName(seedName);
        setSetAsGlobal(batch.items.length === 1);
      } else {
        setCurrentOutcome({
          kind: 'error',
          message: `${result.error.stage}: ${result.error.message}`,
        });
      }
    }

    resolve(entry).catch((error: unknown) => {
      if (cancelled) return;
      console.error('[Palette Mimicry] failed to read theme file', error);
      setCurrentOutcome({
        kind: 'error',
        message: error instanceof Error ? error.message : 'failed to read file',
      });
    });

    return () => {
      cancelled = true;
    };
  }, [batch, currentOutcome]);

  const nextQueueKey = (): string => {
    queueKeySeq.current += 1;
    return queueKeySeq.current.toString();
  };

  const enqueue = (entries: QueueEntry[]): void => {
    if (entries.length === 0) return;
    setBatch((previous) => ({ items: [...previous.items, ...entries], index: previous.index }));
  };

  const enqueueFiles = (files: File[], cardId: string): void => {
    enqueue(
      files.map((file) => ({
        key: `${cardId}:${file.name}:${nextQueueKey()}`,
        source: { kind: 'file', file, cardId },
      })),
    );
  };

  const handleEnableDiskScan = async (): Promise<void> => {
    // Re-entrancy guard: a second click on any card's button while the
    // first click's request/connect is still in flight must not start a
    // second permission prompt or a second connectHost() race.
    if (hostConnectionRef.current.kind === 'connecting') return;
    setHostConnection({ kind: 'connecting' });

    if (!hasNativeMessagingPermission) {
      let granted: boolean;
      try {
        granted = await browser.permissions.request({ permissions: ['nativeMessaging'] });
      } catch (error) {
        console.error('[Palette Mimicry] failed to request nativeMessaging permission', error);
        setHostConnection({ kind: 'idle' });
        return;
      }
      // The user declining the browser's own permission dialog is not a
      // host-absent failure -- no install hint, just revert to idle so
      // every card's button is clickable again.
      if (!granted) {
        setHostConnection({ kind: 'idle' });
        return;
      }
      setHasNativeMessagingPermission(true);
    }

    const result = await connectHost();
    setHostConnection(
      result.ok
        ? { kind: 'connected', session: result.session, close: result.close }
        : { kind: 'error', error: result.error },
    );
  };

  const handleScanCard = async (card: SourceCard): Promise<void> => {
    if (hostConnection.kind !== 'connected') return;
    scanCardIdRef.current = card.id;
    setScanState({ cardId: card.id, phase: 'loading' });

    const result = await hostConnection.session.enumerate();
    // A different card started its own scan while this enumerate() was in
    // flight -- that card's response already owns `scanState`, so this
    // stale one is dropped instead of clobbering it.
    if (scanCardIdRef.current !== card.id) return;
    if (!result.ok) {
      setScanState({ cardId: card.id, phase: 'error', message: result.error.message });
      return;
    }

    const files = result.files.filter((file) => file.sourceId === card.id);
    setScanState({
      cardId: card.id,
      phase: 'ready',
      files,
      selected: new Set(files.map((file) => file.path)),
    });
  };

  const handleToggleScanFile = (path: string): void => {
    setScanState((previous) => {
      if (previous?.phase !== 'ready') return previous;
      const selected = new Set(previous.selected);
      if (selected.has(path)) {
        selected.delete(path);
      } else {
        selected.add(path);
      }
      return { ...previous, selected };
    });
  };

  const handleToggleSelectAllScanFiles = (): void => {
    setScanState((previous) => {
      if (previous?.phase !== 'ready') return previous;
      const selected =
        previous.selected.size === previous.files.length
          ? new Set<string>()
          : new Set(previous.files.map((file) => file.path));
      return { ...previous, selected };
    });
  };

  const handleCancelScan = (): void => {
    setScanState(null);
  };

  const handleImportSelectedScanFiles = async (): Promise<void> => {
    const current = scanState;
    if (current?.phase !== 'ready') return;
    if (hostConnectionRef.current.kind !== 'connected') return;
    const session = hostConnectionRef.current.session;
    const filesToImport = current.files.filter((file) => current.selected.has(file.path));
    // Captured now so the completion guard below can tell whether this
    // import's card is still the one scanCardIdRef points at once the
    // read() loop finishes -- see the comment there.
    const owningCardId = current.cardId;

    setScanState({ ...current, phase: 'importing' });

    // Sequential, not parallel: each read() is a full native-messaging
    // round trip, and a failing file (deleted since enumerate, permission
    // change) must not abort the rest of the selection -- it's reported
    // inline and the loop continues.
    const entries: QueueEntry[] = [];
    const failedNames: string[] = [];
    for (const file of filesToImport) {
      const { baseName } = splitScanPath(file.path);
      const result = await session.read(file.path);
      if (result.ok) {
        entries.push({
          key: `scan:${current.cardId}:${file.path}:${nextQueueKey()}`,
          source: {
            kind: 'scan',
            content: result.content,
            cardId: current.cardId,
            fileName: baseName,
          },
        });
      } else {
        failedNames.push(`${baseName} (${result.error.message})`);
      }
    }

    enqueue(entries);
    // Mirrors handleScanCard's guard: a Scan click on a DIFFERENT card
    // while this import's read() loop was still running moved
    // scanCardIdRef off `owningCardId` and replaced scanState with that
    // card's own panel. Clearing scanState here unconditionally would
    // silently wipe that newer panel, so completion only clears it when
    // this import's card is still the active one.
    if (scanCardIdRef.current === owningCardId) {
      setScanState(null);
    }
    setStatusMessage(describeScanImportOutcome(entries.length, failedNames));
  };

  const advanceQueue = (): void => {
    setBatch((previous) => {
      const nextIndex = previous.index + 1;
      return nextIndex >= previous.items.length
        ? EMPTY_BATCH
        : { items: previous.items, index: nextIndex };
    });
    setCurrentOutcome(null);
    setEditedName('');
    setSetAsGlobal(false);
  };

  const handlePickForCard = async (card: SourceCard): Promise<void> => {
    const picker = readFilePicker(window);
    if (!picker) return;

    try {
      const options: FilePickerOptions = {
        multiple: true,
        id: card.id,
        ...(card.pickerExtensions.length > 0
          ? {
              types: [{ description: card.label, accept: { 'text/plain': card.pickerExtensions } }],
            }
          : {}),
      };
      const handles = await picker(options);
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      enqueueFiles(files, card.id);
    } catch (error) {
      // AbortError is the user closing the dialog without picking a file --
      // not a failure worth surfacing.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('[Palette Mimicry] failed to open file picker', error);
      setStatusMessage('Could not open file picker');
    }
  };

  const handleInputFiles = (event: ChangeEvent<HTMLInputElement>, cardId: string): void => {
    const files = event.target.files;
    if (files) enqueueFiles(Array.from(files), cardId);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    enqueueFiles(Array.from(event.dataTransfer.files), 'file');
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
  };

  const handlePasteImport = (): void => {
    if (pasteText.trim().length === 0) return;
    enqueue([
      {
        key: `paste:${nextQueueKey()}`,
        source: { kind: 'paste', content: pasteText, cardId: 'file' },
      },
    ]);
    setPasteText('');
  };

  const handleSave = async (): Promise<void> => {
    // Re-entrancy guard: a second click or Enter-repeat while the save below
    // is still in flight must not re-enter this function -- both the button
    // and Skip are also disabled while isSaving, but this is the guard that
    // actually matters (disabled attributes only stop DOM events, not a
    // second in-JS call). Without it, two overlapping calls each pass the
    // unchanged currentOutcome/name checks and each call advanceQueue() at
    // the end, silently skipping the next queued file.
    if (isSaving) return;
    if (currentOutcome?.kind !== 'success') return;
    const trimmedSlug = slugifyThemeName(editedName);
    if (trimmedSlug.length === 0) return;
    const entry = batch.items[batch.index];
    if (!entry) return;

    setIsSaving(true);
    try {
      const saved = await saveImportedTheme(
        {
          name: editedName,
          mode: currentOutcome.theme.mode,
          tokens: currentOutcome.theme.tokens,
          ...(currentOutcome.theme.author !== undefined
            ? { author: currentOutcome.theme.author }
            : {}),
          sourceFormat: currentOutcome.sourceFormat,
        },
        entry.source.cardId,
      );

      if (setAsGlobal) {
        const settings = await getSettings();
        await saveSettings({ ...settings, globalThemeId: saved.id });
      }

      setStatusMessage(`Saved "${saved.name}"`);
      advanceQueue();
    } catch (error) {
      console.error('[Palette Mimicry] failed to save imported theme', error);
      setStatusMessage('Save failed');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (themeId: string): Promise<void> => {
    try {
      await deleteImportedTheme(themeId);
      const settings = await getSettings();
      const pruned = pruneThemeReferences(settings, themeId);
      if (pruned) await saveSettings(pruned);
      setStatusMessage('Theme deleted');
    } catch (error) {
      console.error('[Palette Mimicry] failed to delete imported theme', error);
      setStatusMessage('Delete failed');
    }
  };

  const editedSlug = slugifyThemeName(editedName);
  const existingTheme =
    editedSlug.length > 0
      ? importedThemes.find((theme) => theme.id === importedThemeId(editedName))
      : undefined;
  const saveLabel = existingTheme ? `Replace "${existingTheme.name}"` : 'Save';
  // An edited name that is non-empty but slugs to '' (all-punctuation or
  // non-Latin input) is a distinct failure mode from a genuinely empty
  // field -- "enter a name" is misleading when a name is already there.
  const saveDisabledHint =
    editedName.trim().length > 0
      ? 'Name needs at least one Latin letter or digit'
      : 'Enter a name to save';
  const queueTotal = batch.items.length;

  return (
    <main className="options-shell">
      <header>
        <p className="eyebrow">Palette Mimicry</p>
        <h1>Import a theme</h1>
      </header>

      <section className="panel import-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
        {currentOutcome ? (
          <>
            {queueTotal > 1 && (
              <p className="queue-header">
                {batch.index + 1} of {queueTotal}
              </p>
            )}
            <ImportPreview
              outcome={currentOutcome}
              editedName={editedName}
              onEditedNameChange={setEditedName}
              setAsGlobal={setAsGlobal}
              onSetAsGlobalChange={setSetAsGlobal}
              saveLabel={saveLabel}
              saveDisabled={editedSlug.length === 0}
              saveDisabledHint={saveDisabledHint}
              isSaving={isSaving}
              onSave={handleSave}
              onSkip={advanceQueue}
            />
          </>
        ) : (
          <>
            <div className="source-card-grid">
              {orderedCards.map((card) => (
                <SourceCardView
                  key={card.id}
                  card={card}
                  platform={platform}
                  onPick={handlePickForCard}
                  onInputFiles={handleInputFiles}
                  hostStatus={deriveCardHostStatus(
                    card,
                    hostConnection,
                    hasNativeMessagingPermission,
                  )}
                  scanState={scanState}
                  onEnableDiskScan={handleEnableDiskScan}
                  onScan={handleScanCard}
                  onToggleScanFile={handleToggleScanFile}
                  onToggleSelectAllScanFiles={handleToggleSelectAllScanFiles}
                  onImportSelectedScanFiles={handleImportSelectedScanFiles}
                  onCancelScan={handleCancelScan}
                />
              ))}
            </div>

            {hostConnection.kind === 'error' && (
              <div className="host-install-hint">
                <p>Disk scan needs the MimicEngine host: {hostConnection.error.message}</p>
                <code>brew install barad1tos/tap/mimicengine-host</code>
                <code>mimicengine-host install</code>
                <p className="source-card-hint">
                  Already installed? Run <code>mimicengine-host doctor</code> to check the setup.
                </p>
              </div>
            )}

            <p className="drop-hint">Drop a theme file anywhere in this panel to import it.</p>

            <form
              className="paste-zone"
              onSubmit={(event) => {
                event.preventDefault();
                handlePasteImport();
              }}
            >
              <textarea
                value={pasteText}
                onChange={(event) => {
                  setPasteText(event.target.value);
                }}
                placeholder="Paste theme config"
                rows={4}
              />
              <button type="submit" disabled={pasteText.trim().length === 0}>
                Import pasted config
              </button>
            </form>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Imported themes</h2>
        {importedThemes.length === 0 ? (
          <p className="empty-hint">No imported themes yet.</p>
        ) : (
          <ul className="imported-theme-list">
            {importedThemes.map((theme) => (
              <ImportedThemeRow key={theme.id} theme={theme} onDelete={handleDelete} />
            ))}
          </ul>
        )}
      </section>

      <footer>
        <span>{statusMessage}</span>
      </footer>
    </main>
  );
}
