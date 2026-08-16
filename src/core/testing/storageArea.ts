import { vi } from 'vitest';

// Minimal in-memory stand-in for a single `browser.storage.*` area
// (`local` or `session`), shared by the wxt/browser fakes in
// `settingsStore.storage.test.ts`, `diagnostics.storage.test.ts`, and
// `pageThemeController.test.ts`.
// `get`/`set` are `vi.fn()` so individual tests can force a thrown error via
// `mockImplementationOnce` to exercise swallow-and-warn paths, or return a
// controlled pending Promise to stall an in-flight read. `get` resolves via
// `Promise.resolve` (rather than returning the value synchronously) to match
// the real `browser.storage.*.get()` contract, which is always async. `get`
// accepts either a single key or an array of keys -- the controller's batched
// readApplyInputs() read passes an array to fetch settings and imported
// themes in one call; every other caller still passes a single string key.
export function createStorageArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((keys: string | string[]): Promise<Record<string, unknown>> => {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of requestedKeys) {
        if (data.has(key)) result[key] = data.get(key);
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    }),
  };
}
