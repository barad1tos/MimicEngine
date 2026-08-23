import { browser } from 'wxt/browser';
import { THEME_TOKEN_NAMES, type PaletteTheme } from '../themes';
import type { SiteOverride, SiteSettings } from './settingsStore';

export type StyleCacheContext = {
  siteKey: string;
  pathname: string;
  theme: PaletteTheme;
  settings: SiteSettings;
};

type CacheEntry = {
  css: string;
  createdAt: number;
};

type CacheStore = {
  schemaVersion: 1;
  engineRevision: 1;
  entries: Record<string, CacheEntry>;
};

export const STYLE_CACHE_KEY = 'palette-mimicry:style-cache';

const SCHEMA_VERSION = 1;
const ENGINE_REVISION = 1;
const ENTRY_TTL_MS = 1_800_000;
const MAX_ENTRIES = 32;
const MAX_CSS_LENGTH = 65_536;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const UNSAFE_CSS_PATTERN = /@import|url\s*\(|<\/style/iu;
const MESSAGE_CHANNEL = STYLE_CACHE_KEY;
let clientWriteGeneration = 0;
// One service worker serves every tab. Serialize its read-modify-write cycle
// so two routes cannot read the same old store and then overwrite each other.
let pendingCacheWrite: Promise<void> = Promise.resolve();

type CacheRequest =
  | { channel: typeof MESSAGE_CHANNEL; operation: 'read'; fingerprint: string }
  | { channel: typeof MESSAGE_CHANNEL; operation: 'write'; fingerprint: string; css: string };

type CacheResponse =
  | { channel: typeof MESSAGE_CHANNEL; operation: 'read'; css: string | null }
  | { channel: typeof MESSAGE_CHANNEL; operation: 'write'; stored: boolean };

type CacheResponder = (response: CacheResponse) => void;

export async function readCachedStylesheet(context: StyleCacheContext): Promise<string | null> {
  if (!isCacheablePath(context.pathname)) return null;

  try {
    const fingerprint = await contextFingerprint(context);
    const response: unknown = await browser.runtime.sendMessage({
      channel: MESSAGE_CHANNEL,
      operation: 'read',
      fingerprint,
    } satisfies CacheRequest);
    const css = readResponseCss(response);
    if (css === undefined) {
      console.warn(
        '[Palette Mimicry] failed to read cached stylesheet',
        new Error('background returned an invalid cache response'),
      );
      return null;
    }
    return css;
  } catch (error) {
    console.warn('[Palette Mimicry] failed to read cached stylesheet', error);
    return null;
  }
}

export async function writeCachedStylesheet(
  context: StyleCacheContext,
  css: string,
): Promise<void> {
  if (!isCacheablePath(context.pathname) || !isCacheableCss(css)) return;

  const generation = ++clientWriteGeneration;
  try {
    const fingerprint = await contextFingerprint(context);
    if (generation !== clientWriteGeneration) return;
    const response: unknown = await browser.runtime.sendMessage({
      channel: MESSAGE_CHANNEL,
      operation: 'write',
      fingerprint,
      css,
    } satisfies CacheRequest);
    if (!isStoredWriteResponse(response)) {
      console.warn(
        '[Palette Mimicry] failed to write cached stylesheet',
        new Error('background rejected cached stylesheet'),
      );
    }
  } catch (error) {
    console.warn('[Palette Mimicry] failed to write cached stylesheet', error);
  }
}

export function routeStyleCache(message: unknown, respond: CacheResponder): boolean {
  const request = normalizeRequest(message);
  if (!request) return false;

  if (request.operation === 'read') {
    void readStoredStylesheet(request.fingerprint).then((css) => {
      respond({ channel: MESSAGE_CHANNEL, operation: 'read', css });
    });
    return true;
  }

  void writeStoredStylesheet(request.fingerprint, request.css).then((stored) => {
    respond({ channel: MESSAGE_CHANNEL, operation: 'write', stored });
  });
  return true;
}

async function readStoredStylesheet(fingerprint: string): Promise<string | null> {
  try {
    const result = await browser.storage.session.get<Record<string, unknown>>(STYLE_CACHE_KEY);
    const store = normalizeStore(result[STYLE_CACHE_KEY]);
    const entry = store?.entries[fingerprint];
    return entry && isFresh(entry, Date.now()) ? entry.css : null;
  } catch (error) {
    console.warn('[Palette Mimicry] failed to read cached stylesheet', error);
    return null;
  }
}

function writeStoredStylesheet(fingerprint: string, css: string): Promise<boolean> {
  const write = pendingCacheWrite.then(() => storeStylesheet(fingerprint, css));
  pendingCacheWrite = write.then(() => undefined);
  return write;
}

async function storeStylesheet(fingerprint: string, css: string): Promise<boolean> {
  try {
    const result = await browser.storage.session.get<Record<string, unknown>>(STYLE_CACHE_KEY);
    const stored = normalizeStore(result[STYLE_CACHE_KEY]);
    const now = Date.now();
    const entries = Object.fromEntries(
      Object.entries(stored?.entries ?? {}).filter(([, entry]) => isFresh(entry, now)),
    );
    entries[fingerprint] = { css, createdAt: now };

    const boundedEntries = Object.fromEntries(
      Object.entries(entries)
        .sort(([firstKey, first], [secondKey, second]) => {
          const ageOrder = second.createdAt - first.createdAt;
          return ageOrder === 0 ? compareStrings(firstKey, secondKey) : ageOrder;
        })
        .slice(0, MAX_ENTRIES),
    );
    const nextStore: CacheStore = {
      schemaVersion: SCHEMA_VERSION,
      engineRevision: ENGINE_REVISION,
      entries: boundedEntries,
    };

    await browser.storage.session.set({ [STYLE_CACHE_KEY]: nextStore });
    return true;
  } catch {
    return false;
  }
}

function normalizeRequest(message: unknown): CacheRequest | null {
  if (!isRecord(message) || message.channel !== MESSAGE_CHANNEL) return null;
  if (typeof message.fingerprint !== 'string' || !DIGEST_PATTERN.test(message.fingerprint)) {
    return null;
  }

  const fingerprint = message.fingerprint;
  if (message.operation === 'read') {
    return { channel: MESSAGE_CHANNEL, operation: 'read', fingerprint };
  }
  if (
    message.operation === 'write' &&
    typeof message.css === 'string' &&
    isCacheableCss(message.css)
  ) {
    return { channel: MESSAGE_CHANNEL, operation: 'write', fingerprint, css: message.css };
  }
  return null;
}

function readResponseCss(response: unknown): string | null | undefined {
  if (!isRecord(response)) return undefined;
  if (response.channel !== MESSAGE_CHANNEL || response.operation !== 'read') return undefined;
  if (response.css === null) return null;
  return typeof response.css === 'string' && isCacheableCss(response.css)
    ? response.css
    : undefined;
}

function isStoredWriteResponse(response: unknown): boolean {
  return (
    isRecord(response) &&
    response.channel === MESSAGE_CHANNEL &&
    response.operation === 'write' &&
    response.stored === true
  );
}

function isCacheablePath(pathname: string): boolean {
  return pathname.length > 0 && !pathname.includes('?') && !pathname.includes('#');
}

function isCacheableCss(css: string): boolean {
  return (
    css.length > 0 &&
    css.length <= MAX_CSS_LENGTH &&
    css.startsWith(':root {') &&
    css.includes('--pm-canvas') &&
    !UNSAFE_CSS_PATTERN.test(css)
  );
}

function isFresh(entry: CacheEntry, now: number): boolean {
  const age = now - entry.createdAt;
  return age >= 0 && age <= ENTRY_TTL_MS;
}

function normalizeStore(value: unknown): CacheStore | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || value.engineRevision !== ENGINE_REVISION) {
    return null;
  }
  if (!isRecord(value.entries)) return null;

  const entries: Record<string, CacheEntry> = {};
  for (const [fingerprint, entry] of Object.entries(value.entries)) {
    if (!DIGEST_PATTERN.test(fingerprint) || !isRecord(entry)) continue;
    if (typeof entry.css !== 'string' || !isCacheableCss(entry.css)) continue;
    if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) continue;
    entries[fingerprint] = { css: entry.css, createdAt: entry.createdAt };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    engineRevision: ENGINE_REVISION,
    entries,
  };
}

async function contextFingerprint(context: StyleCacheContext): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalContext(context)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalContext(context: StyleCacheContext): string {
  const overrides = [...context.settings.overrides].sort(compareOverrides);
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    engineRevision: ENGINE_REVISION,
    siteKey: context.siteKey,
    pathname: context.pathname,
    theme: {
      id: context.theme.id,
      mode: context.theme.mode,
      tokens: THEME_TOKEN_NAMES.map((name) => [name, context.theme.tokens[name]]),
    },
    settings: {
      strategy: context.settings.strategy,
      preserveImages: context.settings.preserveImages,
      preserveBrandColors: context.settings.preserveBrandColors,
      overrides,
    },
  });
}

function compareOverrides(first: SiteOverride, second: SiteOverride): number {
  return (
    compareStrings(first.selector, second.selector) ||
    compareStrings(first.property, second.property)
  );
}

function compareStrings(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
