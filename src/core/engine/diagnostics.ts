import { browser } from 'wxt/browser';
import type { CoverageReport } from './coverage';
import type { StrategyPlan } from './decisionTable';
import type { PageMetrics } from './pageMetrics';

export type CensusDiagnostics = {
  complete: boolean;
  signatureCount: number;
  elementsVisited: number;
  droppedProperties: number;
};

export type PlanDiagnostics = {
  siteKey: string;
  plan: StrategyPlan;
  metrics: PageMetrics;
  coverage?: CoverageReport;
  census?: CensusDiagnostics;
  updatedAt: string;
};

export const PLAN_STORAGE_PREFIX = 'palette-mimicry:plan:';
const MESSAGE_CHANNEL = 'palette-mimicry:plan-diagnostics';

type DiagnosticsRequest = {
  channel: typeof MESSAGE_CHANNEL;
  operation: 'write';
  diagnostics: PlanDiagnostics;
};

type DiagnosticsResponse = {
  channel: typeof MESSAGE_CHANNEL;
  operation: 'write';
  stored: boolean;
};

type DiagnosticsResponder = (response: DiagnosticsResponse) => void;

export function planStorageKey(siteKey: string): string {
  return `${PLAN_STORAGE_PREFIX}${siteKey}`;
}

// Shared shape guard for every place an untyped value claims to be
// PlanDiagnostics: readPlanDiagnostics' storage read, and the popup's
// storage.onChanged listener (which receives the raw newValue from a
// browser API, not something this module controls). Deliberately shallow —
// object-ness, provenance.kind, array-ness of an 'auto' provenance's
// strategies list, and object-ness of the optional census block when
// present — not a full deep validator; a value that passes this but is
// otherwise malformed is a display bug, not a theming or storage-safety one.
// Invalid input is the caller's job to turn into null/ignore.
export function isPlanDiagnostics(value: unknown): value is PlanDiagnostics {
  if (typeof value !== 'object' || value === null) return false;

  const { plan } = value as { plan?: unknown };
  if (typeof plan !== 'object' || plan === null) return false;

  const { provenance } = plan as { provenance?: unknown };
  if (typeof provenance !== 'object' || provenance === null) return false;

  const { kind, strategies } = provenance as { kind?: unknown; strategies?: unknown };
  if (kind !== 'auto' && kind !== 'manual') return false;
  if (kind === 'auto' && !Array.isArray(strategies)) return false;

  const { census } = value as { census?: unknown };
  const isCensusObject = typeof census === 'object' && census !== null;
  if (census !== undefined && !isCensusObject) return false;

  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setDiagnostics(diagnostics: PlanDiagnostics): Promise<void> {
  const key = planStorageKey(diagnostics.siteKey);
  await browser.storage.session.set<Record<string, PlanDiagnostics>>({ [key]: diagnostics });
}

async function requestDiagnosticsWrite(diagnostics: PlanDiagnostics): Promise<void> {
  const response: unknown = await browser.runtime.sendMessage({
    channel: MESSAGE_CHANNEL,
    operation: 'write',
    diagnostics,
  } satisfies DiagnosticsRequest);
  if (!isDiagnosticsResponse(response) || !response.stored) {
    throw new Error('background rejected plan diagnostics');
  }
}

// Diagnostics are a debugging aid, never load-bearing for theming — a failed
// write here must never surface as a theming failure, hence the swallow-and-warn.
// A narrow runtime message keeps storage.session inside the trusted background
// context. One bounded retry covers a transient worker startup failure without
// turning this into an unbounded retry loop.
export async function writePlanDiagnostics(diagnostics: PlanDiagnostics): Promise<void> {
  try {
    await requestDiagnosticsWrite(diagnostics);
  } catch {
    try {
      await delay(1000);
      await requestDiagnosticsWrite(diagnostics);
    } catch (error) {
      console.warn('[Palette Mimicry] failed to write plan diagnostics', error);
    }
  }
}

export function routePlanDiagnostics(message: unknown, respond: DiagnosticsResponder): boolean {
  if (!isRecord(message) || message.channel !== MESSAGE_CHANNEL || message.operation !== 'write') {
    return false;
  }
  if (!isPlanDiagnostics(message.diagnostics)) return false;

  void setDiagnostics(message.diagnostics)
    .then(() => {
      respond({ channel: MESSAGE_CHANNEL, operation: 'write', stored: true });
    })
    .catch(() => {
      respond({ channel: MESSAGE_CHANNEL, operation: 'write', stored: false });
    });
  return true;
}

export async function readPlanDiagnostics(siteKey: string): Promise<PlanDiagnostics | null> {
  try {
    const key = planStorageKey(siteKey);
    const result = await browser.storage.session.get<Record<string, unknown>>(key);
    const value = result[key];
    return isPlanDiagnostics(value) ? value : null;
  } catch (error) {
    console.warn('[Palette Mimicry] failed to read plan diagnostics', error);
    return null;
  }
}

function isDiagnosticsResponse(value: unknown): value is DiagnosticsResponse {
  return (
    isRecord(value) &&
    value.channel === MESSAGE_CHANNEL &&
    value.operation === 'write' &&
    typeof value.stored === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
