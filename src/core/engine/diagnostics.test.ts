import { describe, expect, it } from 'vitest';
import {
  isPlanDiagnostics,
  PLAN_STORAGE_PREFIX,
  planStorageKey,
  type PlanDiagnostics,
} from './diagnostics';

describe('planStorageKey', () => {
  it('namespaces the site key under the plan storage prefix', () => {
    expect(planStorageKey('example.com')).toBe(`${PLAN_STORAGE_PREFIX}example.com`);
  });
});

describe('PlanDiagnostics', () => {
  it('survives a JSON round-trip unchanged (session storage is JSON-shaped)', () => {
    const diagnostics: PlanDiagnostics = {
      siteKey: 'example.com',
      plan: {
        provenance: {
          kind: 'auto',
          rule: 'variables-capable',
          strategies: ['baseline', 'variableRemap'],
          reasons: [{ metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } }],
          tableVersion: 1,
        },
      },
      metrics: {
        colorCustomPropertyCount: 8,
        domElementCount: 120,
        shadowRootCount: 1,
        unreadableStylesheetCount: 1,
        unreadableStylesheetRatio: 0.25,
        authoredColorCount: 5,
        inlineStyleColorCount: 2,
        customPropertyColorRatio: 0.6,
        mutationRate: 1.5,
      },
      updatedAt: '2026-08-15T00:00:00.000Z',
    };

    const roundTripped = JSON.parse(JSON.stringify(diagnostics)) as PlanDiagnostics;

    expect(roundTripped).toEqual(diagnostics);
  });

  it('survives a JSON round-trip with coverage', () => {
    const diagnostics: PlanDiagnostics = {
      siteKey: 'example.com',
      plan: {
        provenance: {
          kind: 'auto',
          rule: 'variables-capable',
          strategies: ['baseline', 'variableRemap'],
          reasons: [{ metric: 'colorCustomPropertyCount', value: 8, condition: { gte: 8 } }],
          tableVersion: 1,
        },
      },
      metrics: {
        colorCustomPropertyCount: 8,
        domElementCount: 120,
        shadowRootCount: 1,
        unreadableStylesheetCount: 1,
        unreadableStylesheetRatio: 0.25,
        authoredColorCount: 5,
        inlineStyleColorCount: 2,
        customPropertyColorRatio: 0.6,
        mutationRate: 1.5,
      },
      coverage: {
        discovered: 12,
        mapped: 10,
        ratio: 10 / 12,
      },
      updatedAt: '2026-08-15T00:00:00.000Z',
    };

    const roundTripped = JSON.parse(JSON.stringify(diagnostics)) as PlanDiagnostics;

    expect(roundTripped).toEqual(diagnostics);
  });
});

describe('isPlanDiagnostics', () => {
  const validAuto: PlanDiagnostics = {
    siteKey: 'example.com',
    plan: {
      provenance: {
        kind: 'auto',
        rule: 'variables-capable',
        strategies: ['baseline'],
        reasons: [],
        tableVersion: 1,
      },
    },
    metrics: {
      colorCustomPropertyCount: 0,
      domElementCount: 0,
      shadowRootCount: 0,
      unreadableStylesheetCount: 0,
      unreadableStylesheetRatio: 0,
      authoredColorCount: 0,
      inlineStyleColorCount: 0,
      customPropertyColorRatio: 0,
      mutationRate: 0,
    },
    updatedAt: '2026-08-15T00:00:00.000Z',
  };

  it('accepts a valid auto-provenance PlanDiagnostics', () => {
    expect(isPlanDiagnostics(validAuto)).toBe(true);
  });

  it('accepts a valid manual-provenance PlanDiagnostics (no strategies array required)', () => {
    const validManual: PlanDiagnostics = {
      ...validAuto,
      plan: { provenance: { kind: 'manual', strategy: 'baseline' } },
    };

    expect(isPlanDiagnostics(validManual)).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isPlanDiagnostics(null)).toBe(false);
    expect(isPlanDiagnostics(undefined)).toBe(false);
    expect(isPlanDiagnostics('a string')).toBe(false);
    expect(isPlanDiagnostics(42)).toBe(false);
  });

  it('rejects a missing or malformed plan.provenance.kind', () => {
    expect(isPlanDiagnostics({ ...validAuto, plan: {} })).toBe(false);
    expect(isPlanDiagnostics({ ...validAuto, plan: { provenance: {} } })).toBe(false);
    expect(isPlanDiagnostics({ ...validAuto, plan: { provenance: { kind: 'bogus' } } })).toBe(
      false,
    );
  });

  it("rejects an 'auto' provenance whose strategies is not an array", () => {
    const malformed = {
      ...validAuto,
      plan: {
        provenance: { ...validAuto.plan.provenance, strategies: 'not-an-array' },
      },
    };

    expect(isPlanDiagnostics(malformed)).toBe(false);
  });

  it('accepts records with and without the census block', () => {
    expect(isPlanDiagnostics(validAuto)).toBe(true);
    expect(
      isPlanDiagnostics({
        ...validAuto,
        census: { complete: false, signatureCount: 12, elementsVisited: 340, droppedProperties: 1 },
      }),
    ).toBe(true);
  });
});
