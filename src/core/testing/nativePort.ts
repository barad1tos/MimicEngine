import { vi } from 'vitest';

// Minimal in-memory stand-in for a `runtime.Port`, the object
// `browser.runtime.connectNative(...)` returns — shared by
// `hostClient.test.ts`. `postMessage`/`disconnect` are `vi.fn()`s so tests
// can assert on what the client sent and whether it tore the port down.
// `onMessage`/`onDisconnect` are minimal fake `events.Event` objects:
// `addListener` records the callback the real browser would invoke on an
// inbound frame or a disconnect, and `emit` drives it directly, standing in
// for the browser dispatching that event. Matching the real Port contract,
// `disconnect()` does NOT emit this port's own `onDisconnect` — the browser
// only fires that event on the *other* end when a port closes itself (MDN:
// "If the port is closed via disconnect(), then this event is only fired
// on the other end"); tests simulate a host-initiated disconnect by calling
// `onDisconnect.emit(...)` directly instead.
function createFakeEvent<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: vi.fn((listener: (...args: Args) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (...args: Args) => void) => {
      listeners.delete(listener);
    }),
    hasListener: vi.fn((listener: (...args: Args) => void) => listeners.has(listener)),
    hasListeners: vi.fn(() => listeners.size > 0),
    emit: (...args: Args): void => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

export function createFakePort(name = 'com.barad1tos.mimicengine') {
  return {
    name,
    postMessage: vi.fn((_message: unknown) => undefined),
    disconnect: vi.fn(() => undefined),
    onMessage: createFakeEvent<[unknown, unknown]>(),
    onDisconnect: createFakeEvent<[unknown]>(),
  };
}
