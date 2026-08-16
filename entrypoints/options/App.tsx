import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
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
  { kind: 'file'; file: File; cardId: string } | { kind: 'paste'; content: string; cardId: string };

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

function SourceCardView({
  card,
  platform,
  onPick,
  onInputFiles,
}: Readonly<{
  card: SourceCard;
  platform: ReturnType<typeof detectPlatform>;
  onPick: (card: SourceCard) => Promise<void>;
  onInputFiles: (event: ChangeEvent<HTMLInputElement>, cardId: string) => void;
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
  const queueKeySeq = useRef(0);
  // Same last-write-wins discipline as the popup's T12 pattern: the mount-time
  // load races the local-area onChanged listener below, and a stale slow load
  // must not clobber a fresher onChanged refresh.
  const importedThemesSeq = useRef(0);

  const platform = detectPlatform(resolveNavigatorPlatform(navigator));
  const orderedCards = orderSourceCards(recentSources, platform);

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
        // A picked/dropped file whose adapter produced a format-default name
        // (no name of its own) seeds a stronger name from the file's
        // basename instead, so two nameless imports don't collide on the
        // same slug and silently replace one another. Pasted content has no
        // filename, so it keeps the format default (the Replace-labeled
        // save button still makes a same-name collision explicit there).
        const seedName =
          currentEntry.source.kind === 'file' && FORMAT_DEFAULT_THEME_NAMES.has(result.theme.name)
            ? basenameWithoutExtension(currentEntry.source.file.name)
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
                />
              ))}
            </div>

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
