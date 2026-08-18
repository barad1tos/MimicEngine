import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { browser } from 'wxt/browser';
import { createFakePort } from '../testing/nativePort';
import { connectHost } from './hostClient';
import { PROTOCOL_VERSION } from './protocol';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { connectNative: vi.fn() } },
}));

const fakeBrowser = browser as unknown as {
  runtime: { connectNative: Mock };
};

let port: ReturnType<typeof createFakePort>;

beforeEach(() => {
  port = createFakePort();
  fakeBrowser.runtime.connectNative.mockReturnValue(port);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pingReply(id: number, protocolVersion = PROTOCOL_VERSION, sourceIds = ['jetbrains-ui']) {
  return { id, ok: true, version: '0.1.0', protocolVersion, sourceIds };
}

function enumerateReply(id: number) {
  return {
    id,
    ok: true,
    files: [
      {
        path: 'a.theme.json',
        size: 42,
        modifiedAt: '2026-01-01T00:00:00Z',
        sourceId: 'jetbrains-ui',
      },
    ],
  };
}

function readReply(id: number, content = 'theme body') {
  return { id, ok: true, content };
}

function errorReply(id: number, code = 'not-found', message = 'no such file') {
  return { id, ok: false, error: { code, message } };
}

// A ping handshake always claims id 1 on a fresh connection (openConnection's
// counter starts at 1); every session-level test below opens a session first
// and so can rely on the next two requests being ids 2 and 3.
async function connectSession() {
  const resultPromise = connectHost();
  port.onMessage.emit(pingReply(1), port);
  const result = await resultPromise;
  if (!result.ok) throw new Error(`expected connectHost() to succeed: ${result.error.message}`);
  return result;
}

describe('connectHost handshake', () => {
  it('resolves ok:true with a session carrying the host-advertised sourceIds', async () => {
    const resultPromise = connectHost();
    expect(port.postMessage).toHaveBeenCalledWith({ id: 1, op: 'ping' });

    port.onMessage.emit(pingReply(1, PROTOCOL_VERSION, ['jetbrains-ui', 'vscode']), port);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sourceIds).toEqual(['jetbrains-ui', 'vscode']);
    expect(typeof result.close).toBe('function');
  });

  it('resolves ok:false with version-mismatch and closes the port when protocolVersion differs', async () => {
    const resultPromise = connectHost();
    port.onMessage.emit(pingReply(1, PROTOCOL_VERSION + 1), port);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'version-mismatch',
        message: `host protocol version ${String(PROTOCOL_VERSION + 1)} does not match expected ${String(PROTOCOL_VERSION)}`,
      },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves ok:false with timeout and closes the port when the host never answers ping', async () => {
    vi.useFakeTimers();
    const resultPromise = connectHost();

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: { code: 'timeout', message: "host did not respond to 'ping' within 5000ms" },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves ok:false with the host error when ping itself comes back ok:false', async () => {
    const resultPromise = connectHost();
    port.onMessage.emit(errorReply(1, 'internal-error', 'sandbox init failed'), port);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: { code: 'internal-error', message: 'sandbox init failed' },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves ok:false with bad-request and closes the port when the ping reply has an unexpected shape', async () => {
    const resultPromise = connectHost();
    // A same-id reply shaped like an enumerate response instead of a ping
    // response: passes the router-level shape guard (it's a valid envelope
    // family) but fails the ping-specific one.
    port.onMessage.emit(enumerateReply(1), port);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'host ping response has an unexpected shape' },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves ok:false with transport when connectNative throws synchronously', async () => {
    fakeBrowser.runtime.connectNative.mockImplementationOnce(() => {
      throw new Error('no such native messaging host');
    });

    const result = await connectHost();

    expect(result).toEqual({
      ok: false,
      error: { code: 'transport', message: 'no such native messaging host' },
    });
  });

  // postMessage on an already-dead port throws synchronously (most commonly:
  // the native host isn't installed at all) rather than routing through
  // onDisconnect. Without send()'s try/catch guard this throw would escape
  // the Promise executor as a rejection — connectHost() must still resolve,
  // never reject, on the very first ping.
  it('resolves ok:false with transport, not a rejection, when postMessage throws during the ping handshake', async () => {
    port.postMessage.mockImplementationOnce(() => {
      throw new Error('native host process exited');
    });

    await expect(connectHost()).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host process exited' },
    });
  });
});

describe('HostSession request correlation and timeouts', () => {
  it('routes interleaved responses to the correct in-flight request by id', async () => {
    const { session } = await connectSession();

    const enumeratePromise = session.enumerate();
    const readPromise = session.read('a.theme.json');
    expect(port.postMessage).toHaveBeenCalledWith({ id: 2, op: 'enumerate' });
    expect(port.postMessage).toHaveBeenCalledWith({ id: 3, op: 'read', path: 'a.theme.json' });

    // Reply out of order: the later request (id 3) settles before the
    // earlier one (id 2).
    port.onMessage.emit(readReply(3, 'theme body'), port);
    port.onMessage.emit(enumerateReply(2), port);

    await expect(readPromise).resolves.toEqual({ ok: true, content: 'theme body' });
    await expect(enumeratePromise).resolves.toEqual({
      ok: true,
      files: [
        {
          path: 'a.theme.json',
          size: 42,
          modifiedAt: '2026-01-01T00:00:00Z',
          sourceId: 'jetbrains-ui',
        },
      ],
    });
  });

  it('times out read() after 5s when the host never responds', async () => {
    vi.useFakeTimers();
    const { session } = await connectSession();

    const readPromise = session.read('a.theme.json');
    await vi.advanceTimersByTimeAsync(5000);

    await expect(readPromise).resolves.toEqual({
      ok: false,
      error: { code: 'timeout', message: "host did not respond to 'read' within 5000ms" },
    });
  });

  it('times out enumerate() after 10s when the host never responds', async () => {
    vi.useFakeTimers();
    const { session } = await connectSession();

    const enumeratePromise = session.enumerate();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(enumeratePromise).resolves.toEqual({
      ok: false,
      error: { code: 'timeout', message: "host did not respond to 'enumerate' within 10000ms" },
    });
  });

  it('resolves the host error unchanged when enumerate() itself comes back ok:false', async () => {
    const { session } = await connectSession();

    const enumeratePromise = session.enumerate();
    port.onMessage.emit(errorReply(2, 'internal-error', 'walk failed'), port);

    await expect(enumeratePromise).resolves.toEqual({
      ok: false,
      error: { code: 'internal-error', message: 'walk failed' },
    });
  });

  it('resolves ok:false bad-request when the host replies to read() with an enumerate-shaped payload', async () => {
    const { session } = await connectSession();

    const readPromise = session.read('a.theme.json');
    port.onMessage.emit(enumerateReply(2), port);

    await expect(readPromise).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'host read response has an unexpected shape' },
    });
  });

  it('drops a garbage frame with a warning and still resolves once the real response arrives', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session } = await connectSession();

    const readPromise = session.read('a.theme.json');
    port.onMessage.emit({ nonsense: true }, port);
    port.onMessage.emit(readReply(2, 'theme body'), port);

    await expect(readPromise).resolves.toEqual({ ok: true, content: 'theme body' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Palette Mimicry]'), {
      nonsense: true,
    });
  });

  it('drops a non-object frame (not even a record) with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session } = await connectSession();

    const readPromise = session.read('a.theme.json');
    port.onMessage.emit('not-an-object', port);
    port.onMessage.emit(null, port);
    port.onMessage.emit(readReply(2, 'theme body'), port);

    await expect(readPromise).resolves.toEqual({ ok: true, content: 'theme body' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores a well-formed response whose id has no matching pending request', async () => {
    const { session } = await connectSession();

    // A reply for a request that already settled (or was never sent) must
    // not throw and must not disturb the still-pending read().
    const readPromise = session.read('a.theme.json');
    port.onMessage.emit(readReply(999, 'stray'), port);
    port.onMessage.emit(readReply(2, 'theme body'), port);

    await expect(readPromise).resolves.toEqual({ ok: true, content: 'theme body' });
  });

  it('resolves ok:false with transport, not a rejection, when postMessage throws mid-session', async () => {
    const { session } = await connectSession();
    // The host process can exit without the browser ever firing
    // onDisconnect on this end before the next send is attempted; the very
    // next postMessage throws synchronously in that window.
    port.postMessage.mockImplementationOnce(() => {
      throw new Error('native host disconnected');
    });

    await expect(session.read('a.theme.json')).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host disconnected' },
    });
  });

  it('rejects every pending request as transport when the host disconnects', async () => {
    const { session } = await connectSession();

    const enumeratePromise = session.enumerate();
    const readPromise = session.read('a.theme.json');
    port.onDisconnect.emit(port);

    await expect(enumeratePromise).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host disconnected' },
    });
    await expect(readPromise).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host disconnected' },
    });
  });
});

describe('HostSession.close()', () => {
  it('disconnects the port and fails an in-flight request as transport', async () => {
    const { session, close } = await connectSession();

    const readPromise = session.read('a.theme.json');
    close();

    expect(port.disconnect).toHaveBeenCalledTimes(1);
    await expect(readPromise).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host connection closed' },
    });
  });

  it('makes every subsequent request fail fast as transport without posting a new message', async () => {
    const { session, close } = await connectSession();
    close();
    port.postMessage.mockClear();

    const result = await session.read('a.theme.json');

    expect(result).toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host connection is closed' },
    });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('is safe to call after the host already disconnected — still disconnects the port without throwing', async () => {
    const { session, close } = await connectSession();

    // A duplicate onDisconnect dispatch (defensive against a browser that
    // fires it more than once) must not throw or double-process pending
    // requests, and a caller cleaning up after the fact must still be able
    // to call close() safely.
    port.onDisconnect.emit(port);
    port.onDisconnect.emit(port);
    const readOutcome = await session.read('a.theme.json');
    expect(() => {
      close();
    }).not.toThrow();

    expect(readOutcome).toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host connection is closed' },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('removes the onMessage/onDisconnect listeners from the port', async () => {
    const { close } = await connectSession();
    expect(port.onMessage.hasListeners()).toBe(true);
    expect(port.onDisconnect.hasListeners()).toBe(true);

    close();

    expect(port.onMessage.hasListeners()).toBe(false);
    expect(port.onDisconnect.hasListeners()).toBe(false);
  });

  it('is safe to call twice at the call level — still disconnects the port each time without throwing', async () => {
    const { session, close } = await connectSession();
    const readPromise = session.read('a.theme.json');

    expect(() => {
      close();
      close();
    }).not.toThrow();

    await expect(readPromise).resolves.toEqual({
      ok: false,
      error: { code: 'transport', message: 'native host connection closed' },
    });
    expect(port.disconnect).toHaveBeenCalledTimes(2);
  });
});
