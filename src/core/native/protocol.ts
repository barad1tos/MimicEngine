// Wire protocol shared with the Go native-messaging host
// (host/internal/protocol, host/internal/ops). This file is the
// extension-side mirror of that package's request/response envelopes —
// keep it in lockstep, not an independently-evolving spec. `runtime.
// connectNative` ports exchange parsed objects (the browser handles the
// uint32-length-prefixed framing), so every shape here is a plain JSON
// value, never a byte buffer.

export const HOST_NAME = 'com.barad1tos.mimicengine';
export const PROTOCOL_VERSION = 1;

// Every code the host itself can put on the wire (host/internal/ops'
// codeBadRequest..codeTooLarge constants). `transport`, `version-mismatch`,
// and `timeout` never come from the host — the client synthesizes them for
// failures that happen before or outside a matched response (connection
// drop, protocol handshake mismatch, no reply within the op's deadline).
export const HOST_WIRE_ERROR_CODES = [
  'path-denied',
  'not-found',
  'too-large',
  'bad-request',
  'unsupported-op',
  'internal-error',
] as const;

export type HostWireErrorCode = (typeof HOST_WIRE_ERROR_CODES)[number];
export type HostErrorCode = HostWireErrorCode | 'transport' | 'version-mismatch' | 'timeout';
export type HostError = { code: HostErrorCode; message: string };

export type HostFile = { path: string; size: number; modifiedAt: string; sourceId: string };

// Outbound request bodies (pre-id — hostClient's request counter attaches
// `id` once it assigns one). Mirrors protocol.Request's `{id, op, path?}`:
// `path` is only ever present for `read`, matching the Go struct's
// `omitempty` — ping/enumerate requests carry no `path` key at all rather
// than `path: undefined`.
export type HostRequestBody = { op: 'ping' } | { op: 'enumerate' } | { op: 'read'; path: string };
export type HostRequest = HostRequestBody & { id: number };

export type HostPingResponse = {
  id: number;
  ok: true;
  version: string;
  protocolVersion: number;
  sourceIds: string[];
};

export type HostEnumerateResponse = { id: number; ok: true; files: HostFile[] };
export type HostReadResponse = { id: number; ok: true; content: string };
export type HostErrorResponse = {
  id: number;
  ok: false;
  error: { code: HostWireErrorCode; message: string };
};

export type HostResponse =
  HostPingResponse | HostEnumerateResponse | HostReadResponse | HostErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFileShape(value: unknown): value is HostFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.size === 'number' &&
    typeof value.modifiedAt === 'string' &&
    typeof value.sourceId === 'string'
  );
}

export function isHostPingResponse(value: unknown): value is HostPingResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    value.ok === true &&
    typeof value.version === 'string' &&
    typeof value.protocolVersion === 'number' &&
    isStringArray(value.sourceIds)
  );
}

export function isHostEnumerateResponse(value: unknown): value is HostEnumerateResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    value.ok === true &&
    Array.isArray(value.files) &&
    value.files.every(isFileShape)
  );
}

export function isHostReadResponse(value: unknown): value is HostReadResponse {
  if (!isRecord(value)) return false;
  return typeof value.id === 'number' && value.ok === true && typeof value.content === 'string';
}

export function isHostErrorResponse(value: unknown): value is HostErrorResponse {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'number' || value.ok !== false) return false;
  if (!isRecord(value.error)) return false;
  const code = value.error.code;
  return (
    typeof value.error.message === 'string' &&
    typeof code === 'string' &&
    (HOST_WIRE_ERROR_CODES as readonly string[]).includes(code)
  );
}

// Router-level shape guard: is this literally one of the host's four known
// response envelopes? Deliberately shallow just like isPlanDiagnostics
// (engine/diagnostics.ts) — it exists to drop garbage frames before they're
// ever routed to a pending request, not to fully validate a shape that
// already passed it. hostClient still narrows further per-op (e.g.
// isHostReadResponse) once it knows which request the id belongs to, since
// a same-id response can pass this guard while still being the wrong op's
// shape (host bug, not a wire-format violation).
export function isHostResponse(value: unknown): value is HostResponse {
  return (
    isHostPingResponse(value) ||
    isHostEnumerateResponse(value) ||
    isHostReadResponse(value) ||
    isHostErrorResponse(value)
  );
}
