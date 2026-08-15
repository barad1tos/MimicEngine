import { vi } from 'vitest';

// Minimal in-memory stand-in for a single `browser.storage.*` area
// (`local` or `session`), shared by the wxt/browser fakes in
// `settingsStore.storage.test.ts` and `diagnostics.storage.test.ts`.
// `get`/`set` are `vi.fn()` so individual tests can force a thrown error via
// `mockImplementationOnce` to exercise swallow-and-warn paths.
export function createStorageArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    }),
  };
}
