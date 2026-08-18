import { browser, type Browser } from 'wxt/browser';
import {
  HOST_NAME,
  isHostEnumerateResponse,
  isHostPingResponse,
  isHostReadResponse,
  isHostResponse,
  PROTOCOL_VERSION,
  type HostError,
  type HostFile,
  type HostRequest,
  type HostRequestBody,
  type HostResponse,
} from './protocol';

const PING_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 5000;
const ENUMERATE_TIMEOUT_MS = 10_000;

export type HostSession = {
  readonly sourceIds: readonly string[];
  enumerate(): Promise<{ ok: true; files: readonly HostFile[] } | { ok: false; error: HostError }>;
  read(path: string): Promise<{ ok: true; content: string } | { ok: false; error: HostError }>;
};

export type HostConnectResult =
  { ok: true; session: HostSession; close: () => void } | { ok: false; error: HostError };

type HostFailure = { ok: false; error: HostError };
// A request settles with either a response that matched its id (success or
// a host-reported protocol error — both carry `{ok:false, error}` when
// unsuccessful) or a HostFailure synthesized locally (timeout, disconnect).
// Never a rejection: the errors-as-values discipline holds at this internal
// layer too, so there is exactly one resolution path to reason about.
type RequestOutcome = HostResponse | HostFailure;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutFailure(op: string, timeoutMs: number): HostFailure {
  return {
    ok: false,
    error: {
      code: 'timeout',
      message: `host did not respond to '${op}' within ${String(timeoutMs)}ms`,
    },
  };
}

function transportFailure(message: string): HostFailure {
  return { ok: false, error: { code: 'transport', message } };
}

// Unexpected-shape fallback shared by every op-specific narrowing below: the
// router already accepted the message as *some* valid response envelope
// (isHostResponse), but it doesn't match the shape the op that owns this id
// expects — e.g. a host bug echoing an enumerate-shaped reply to a read
// request. Never surfaced as a thrown error, per the module's no-throws
// contract; the caller sees it as an ordinary `{ok:false}` result.
function unexpectedShapeFailure(op: string): HostFailure {
  return {
    ok: false,
    error: { code: 'bad-request', message: `host ${op} response has an unexpected shape` },
  };
}

type PendingEntry = {
  resolve: (outcome: RequestOutcome) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

// One connectNative() port, the pending-request table it's multiplexed
// over, and the listeners that drive it. Not exported: connectHost() is the
// only way to obtain one, so the ping handshake always runs first.
function openConnection(port: Browser.runtime.Port) {
  const pending = new Map<number, PendingEntry>();
  let nextRequestId = 1;
  let disconnected = false;

  const failAllPending = (failure: HostFailure): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutHandle);
      entry.resolve(failure);
    }
    pending.clear();
  };

  const handleDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    failAllPending(transportFailure('native host disconnected'));
  };

  // Every inbound message passes isHostResponse before it can resolve
  // anything — a frame that doesn't match one of the host's four known
  // envelopes is dropped with a warning instead of routed. A message with
  // no matching pending entry (unknown or already-settled id) is dropped
  // silently: past its own timeout, or a duplicate, either way there is
  // nothing left to route it to.
  const handleMessage = (message: unknown): void => {
    if (!isHostResponse(message)) {
      console.warn('[Palette Mimicry] ignoring malformed native host message', message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timeoutHandle);
    pending.delete(message.id);
    entry.resolve(message);
  };

  port.onDisconnect.addListener(handleDisconnect);
  port.onMessage.addListener(handleMessage);

  const send = (body: HostRequestBody, timeoutMs: number): Promise<RequestOutcome> => {
    if (disconnected) {
      return Promise.resolve(transportFailure('native host connection is closed'));
    }

    const id = nextRequestId++;
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        pending.delete(id);
        resolve(timeoutFailure(body.op, timeoutMs));
      }, timeoutMs);
      pending.set(id, { resolve, timeoutHandle });

      const request: HostRequest = { ...body, id };
      // postMessage throws synchronously on an already-dead port (most
      // commonly: the native host isn't installed at all) rather than
      // routing through onDisconnect — without this guard that throw would
      // escape this Promise executor as a rejection, breaking the
      // errors-as-values contract on the very first request. Mirrors the
      // connectNative guard in connectHost() below.
      try {
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timeoutHandle);
        pending.delete(id);
        resolve(transportFailure(describeError(error)));
      }
    });
  };

  const close = (): void => {
    // A locally-initiated disconnect() never fires this port's own
    // onDisconnect (only the other end sees that event), so pending
    // requests are failed here explicitly rather than relying on the
    // listener above.
    if (!disconnected) {
      disconnected = true;
      failAllPending(transportFailure('native host connection closed'));
    }
    port.onDisconnect.removeListener(handleDisconnect);
    port.onMessage.removeListener(handleMessage);
    port.disconnect();
  };

  return { send, close };
}

// Connects to the native host, runs the ping handshake, and validates its
// protocol version. Resolves to a session on success; every failure path
// (transport, timeout, version mismatch, malformed handshake reply) closes
// the port before returning so a failed connectHost() never leaks a live
// port with no reachable session.
export async function connectHost(): Promise<HostConnectResult> {
  let port: Browser.runtime.Port;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (error) {
    return { ok: false, error: { code: 'transport', message: describeError(error) } };
  }

  const connection = openConnection(port);
  const pingOutcome = await connection.send({ op: 'ping' }, PING_TIMEOUT_MS);

  if (!pingOutcome.ok) {
    connection.close();
    return { ok: false, error: pingOutcome.error };
  }
  if (!isHostPingResponse(pingOutcome)) {
    connection.close();
    return unexpectedShapeFailure('ping');
  }
  if (pingOutcome.protocolVersion !== PROTOCOL_VERSION) {
    connection.close();
    return {
      ok: false,
      error: {
        code: 'version-mismatch',
        message: `host protocol version ${String(pingOutcome.protocolVersion)} does not match expected ${String(PROTOCOL_VERSION)}`,
      },
    };
  }

  const session: HostSession = {
    sourceIds: pingOutcome.sourceIds,
    async enumerate() {
      const outcome = await connection.send({ op: 'enumerate' }, ENUMERATE_TIMEOUT_MS);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      if (!isHostEnumerateResponse(outcome)) return unexpectedShapeFailure('enumerate');
      return { ok: true, files: outcome.files };
    },
    async read(path: string) {
      const outcome = await connection.send({ op: 'read', path }, READ_TIMEOUT_MS);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      if (!isHostReadResponse(outcome)) return unexpectedShapeFailure('read');
      return { ok: true, content: outcome.content };
    },
  };

  return { ok: true, session, close: connection.close };
}
