// The options page's single public entry for theme import. Wires the whole
// pipeline -- detect the source format, dispatch to that format's adapter,
// gap-fill the missing tokens, then validate the result -- and stops at the
// first stage to fail, returning that stage's ImportError untouched.

import { parseAlacrittyTheme } from './adapters/alacritty';
import { parseGhosttyTheme } from './adapters/ghostty';
import { parseItermColors } from './adapters/iterm';
import { parseJetbrainsEditorScheme } from './adapters/jetbrainsEditorScheme';
import { parseJetbrainsUiTheme } from './adapters/jetbrainsUiTheme';
import { parseKittyTheme } from './adapters/kitty';
import { parseVscodeTheme } from './adapters/vscode';
import { deriveGaps } from './derive';
import { detectFormat } from './formatDetection';
import type { ImportError, ImportResult, SourceFormatId, ThemeSlots } from './importTypes';
import { validateImport } from './validateImport';

// One adapter per SourceFormatId. Record<SourceFormatId, ...> makes this map
// exhaustive at compile time: adding a format to importTypes.ts without
// wiring its adapter in here fails to typecheck.
const FORMAT_ADAPTERS: Record<SourceFormatId, (content: string) => ThemeSlots | ImportError> = {
  'jetbrains-ui': parseJetbrainsUiTheme,
  'jetbrains-editor': parseJetbrainsEditorScheme,
  vscode: parseVscodeTheme,
  iterm: parseItermColors,
  alacritty: parseAlacrittyTheme,
  kitty: parseKittyTheme,
  ghostty: parseGhosttyTheme,
};

function isFormatError(result: SourceFormatId | ImportError): result is ImportError {
  return typeof result !== 'string';
}

/**
 * Imports a theme from raw file content: detect its source format, parse it
 * with that format's adapter, gap-fill any tokens the source didn't provide,
 * then validate the assembled token set. Any stage's failure short-circuits
 * the rest and returns that stage's `ImportError`.
 *
 * On success, `theme.id` is always the empty string. Id assembly
 * (`imported:<slug>`) is the importedThemesStore's job at save time, not
 * this function's -- a caller-provided name never determines storage
 * identity here.
 */
export function importTheme(content: string): ImportResult {
  const format = detectFormat(content);
  if (isFormatError(format)) return { ok: false, error: format };

  const slots = FORMAT_ADAPTERS[format](content);
  if ('stage' in slots) return { ok: false, error: slots };

  const derived = deriveGaps(slots);
  if ('stage' in derived) return { ok: false, error: derived };

  const validated = validateImport({
    name: slots.name,
    mode: derived.mode,
    tokens: derived.tokens,
    ...(slots.author !== undefined ? { author: slots.author } : {}),
  });
  if ('stage' in validated) return { ok: false, error: validated };

  return {
    ok: true,
    theme: { id: '', ...validated },
    sourceFormat: format,
    derivedTokens: derived.derivedTokens,
  };
}
