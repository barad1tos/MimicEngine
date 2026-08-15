import { describe, expect, it } from 'vitest';
import { PLAN_STORAGE_PREFIX, planStorageKey, type PlanDiagnostics } from './diagnostics';

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
