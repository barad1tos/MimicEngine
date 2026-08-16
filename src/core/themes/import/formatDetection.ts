// Content-based theme format detection. Ordered sniffers, first match wins.
// Never consults a file name — every signal here comes from `content` alone.

import type { ImportError, SourceFormatId } from './importTypes';
import { stripJsonc } from './jsonc';

const XML_PROLOG_PATTERN = /^<\?[^>]*\?>/;
const XML_COMMENT_PATTERN = /^<!--[\s\S]*?-->/;
const XML_DOCTYPE_PATTERN = /^<!DOCTYPE[^>]*>/;
const XML_PREAMBLE_PATTERNS = [XML_PROLOG_PATTERN, XML_COMMENT_PATTERN, XML_DOCTYPE_PATTERN];
const XML_ROOT_PATTERN = /^<([A-Za-z][\w-]*)/;
const ANSI_COLOR_PATTERN = /Ansi\s+\d+\s+Color/;
const ALACRITTY_SECTION_PATTERN = /^\[colors\.(?:primary|normal)\]/m;
const GHOSTTY_KEY_PATTERN = /^(?:background|foreground|palette)\s*=/m;
const KITTY_KEY_PATTERN = /^(?:background|foreground|color\d{1,2})\s+/m;

function unrecognizedFormatError(): ImportError {
  return { stage: 'detect', message: 'unrecognized theme format' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type FormatOutcome = { format: SourceFormatId } | { error: ImportError };

/** Returns `undefined` when `content` isn't JSON at all, so detection can fall through to XML/TOML/terminal sniffers. */
function sniffJson(content: string): FormatOutcome | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(content));
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return { error: unrecognizedFormatError() };

  if (isRecord(parsed.ui)) return { format: 'jetbrains-ui' };

  const colors = parsed.colors;
  if (isRecord(colors) && Object.keys(colors).some((key) => key.includes('.'))) {
    return { format: 'vscode' };
  }

  return { error: unrecognizedFormatError() };
}

/** Strips a leading XML prolog, comments, and DOCTYPE declaration, in any order. */
function stripXmlPreamble(content: string): string {
  let rest = content.trimStart();
  let strippedAny = true;

  while (strippedAny) {
    strippedAny = false;
    for (const pattern of XML_PREAMBLE_PATTERNS) {
      const match = pattern.exec(rest);
      if (match === null) continue;
      rest = rest.slice(match[0].length).trimStart();
      strippedAny = true;
      break;
    }
  }

  return rest;
}

function sniffXml(content: string): FormatOutcome | undefined {
  const match = XML_ROOT_PATTERN.exec(stripXmlPreamble(content));
  const root = match?.[1];
  if (root === undefined) return undefined;

  if (root === 'plist' && ANSI_COLOR_PATTERN.test(content)) return { format: 'iterm' };
  if (root === 'scheme') return { format: 'jetbrains-editor' };
  return undefined;
}

function resolveOutcome(outcome: FormatOutcome): SourceFormatId | ImportError {
  return 'format' in outcome ? outcome.format : outcome.error;
}

function sniffTerminalConfig(content: string): FormatOutcome {
  if (ALACRITTY_SECTION_PATTERN.test(content)) return { format: 'alacritty' };
  if (GHOSTTY_KEY_PATTERN.test(content)) return { format: 'ghostty' };
  if (KITTY_KEY_PATTERN.test(content)) return { format: 'kitty' };
  return { error: unrecognizedFormatError() };
}

export function detectFormat(content: string): SourceFormatId | ImportError {
  const outcome = sniffJson(content) ?? sniffXml(content) ?? sniffTerminalConfig(content);
  return resolveOutcome(outcome);
}
