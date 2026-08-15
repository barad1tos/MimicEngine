import { describe, expect, it } from 'vitest';
import { deriveMetrics } from './pageMetrics';
import type { PageFacts } from './pageFacts';

const base: PageFacts = {
  customProperties: [],
  authoredRules: [],
  inlineStyleColors: [],
  domElementCount: 100,
  shadowRootCount: 2,
  styleSheetCount: 4,
  unreadableStyleSheetCount: 1,
};

const whiteColor = { r: 255, g: 255, b: 255, a: 1 };
const blackColor = { r: 0, g: 0, b: 0, a: 1 };
const redColor = { r: 255, g: 0, b: 0, a: 1 };

describe('deriveMetrics', () => {
  it('counts only color-valued custom properties', () => {
    const facts: PageFacts = {
      ...base,
      customProperties: [
        {
          name: '--a',
          value: '#fff',
          color: whiteColor,
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
        {
          name: '--b',
          value: '4px',
          color: null,
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
      ],
    };
    expect(deriveMetrics(facts, { mutationRate: 0 }).colorCustomPropertyCount).toBe(1);
  });

  it('computes unreadable ratio and passes counters through', () => {
    const metrics = deriveMetrics(base, { mutationRate: 0 });
    expect(metrics.unreadableStylesheetRatio).toBeCloseTo(0.25);
    expect(metrics.domElementCount).toBe(100);
    expect(metrics.shadowRootCount).toBe(2);
    expect(
      deriveMetrics(
        { ...base, styleSheetCount: 0, unreadableStyleSheetCount: 0 },
        {
          mutationRate: 0,
        },
      ).unreadableStylesheetRatio,
    ).toBe(0);
  });

  it('counts inline style colors (only non-null)', () => {
    const facts: PageFacts = {
      ...base,
      inlineStyleColors: [
        {
          selector: '.a',
          property: 'color',
          value: '#fff',
          color: whiteColor,
          bucket: 'text',
          conditions: [],
        },
        {
          selector: '.b',
          property: 'background-color',
          value: 'not-a-color',
          color: null,
          bucket: 'background',
          conditions: [],
        },
        {
          selector: '.c',
          property: 'color',
          value: '#000',
          color: blackColor,
          bucket: 'text',
          conditions: [],
        },
      ],
    };
    expect(deriveMetrics(facts, { mutationRate: 0 }).inlineStyleColorCount).toBe(2);
  });

  it('counts unique authored colors across authoredRules and inlineStyleColors', () => {
    const facts: PageFacts = {
      ...base,
      authoredRules: [
        {
          selector: 'body',
          property: 'color',
          value: '#fff',
          color: whiteColor,
          bucket: 'text',
          conditions: [],
        },
        {
          selector: 'body',
          property: 'background-color',
          value: '#000',
          color: blackColor,
          bucket: 'background',
          conditions: [],
        },
        // Same color as first (white) — should dedupe
        {
          selector: 'p',
          property: 'color',
          value: '#ffffff',
          color: whiteColor,
          bucket: 'text',
          conditions: [],
        },
      ],
      inlineStyleColors: [
        {
          selector: '.red',
          property: 'color',
          value: '#f00',
          color: redColor,
          bucket: 'text',
          conditions: [],
        },
        // Same color as authoredRules white — should dedupe
        {
          selector: '.white',
          property: 'background-color',
          value: '#fff',
          color: whiteColor,
          bucket: 'background',
          conditions: [],
        },
      ],
    };
    // Should be 3: white, black, red (duplicates deduplicated by toHex)
    expect(deriveMetrics(facts, { mutationRate: 0 }).authoredColorCount).toBe(3);
  });

  it('ignores null colors in authored color count', () => {
    const facts: PageFacts = {
      ...base,
      authoredRules: [
        {
          selector: 'body',
          property: 'color',
          value: '#fff',
          color: whiteColor,
          bucket: 'text',
          conditions: [],
        },
        {
          selector: 'body',
          property: 'font-size',
          value: '14px',
          color: null,
          bucket: 'other',
          conditions: [],
        },
      ],
      inlineStyleColors: [
        {
          selector: '.a',
          property: 'background-color',
          value: 'not-a-color',
          color: null,
          bucket: 'background',
          conditions: [],
        },
      ],
    };
    expect(deriveMetrics(facts, { mutationRate: 0 }).authoredColorCount).toBe(1);
  });

  it('computes customPropertyColorRatio with positive values', () => {
    const facts: PageFacts = {
      ...base,
      customProperties: [
        {
          name: '--a',
          value: '#fff',
          color: whiteColor,
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
        {
          name: '--b',
          value: '#000',
          color: blackColor,
          usage: { background: 0, text: 0, border: 0, other: 0 },
        },
      ],
      authoredRules: [
        {
          selector: 'body',
          property: 'color',
          value: '#f00',
          color: redColor,
          bucket: 'text',
          conditions: [],
        },
      ],
    };
    // colorCustomPropertyCount = 2, authoredColorCount = 1 + 2 = 3
    // ratio = 2 / (1 + 2) = 2/3
    const metrics = deriveMetrics(facts, { mutationRate: 0 });
    expect(metrics.customPropertyColorRatio).toBeCloseTo(2 / 3);
  });

  it('returns 0 for customPropertyColorRatio when both counts are 0', () => {
    const facts: PageFacts = {
      ...base,
      customProperties: [],
      authoredRules: [],
      inlineStyleColors: [],
    };
    // colorCustomPropertyCount = 0, authoredColorCount = 0
    // ratio = 0 / max(1, 0 + 0) = 0 / 1 = 0
    expect(deriveMetrics(facts, { mutationRate: 0 }).customPropertyColorRatio).toBe(0);
  });

  it('passes mutationRate through from runtime parameter', () => {
    const facts: PageFacts = base;
    expect(deriveMetrics(facts, { mutationRate: 0 }).mutationRate).toBe(0);
    expect(deriveMetrics(facts, { mutationRate: 5.5 }).mutationRate).toBe(5.5);
    expect(deriveMetrics(facts, { mutationRate: 100 }).mutationRate).toBe(100);
  });

  it('table-driven: comprehensive scenario with all new fields', () => {
    const scenarios = [
      {
        name: 'no colors',
        facts: { ...base },
        runtime: { mutationRate: 2.1 },
        expect: {
          authoredColorCount: 0,
          inlineStyleColorCount: 0,
          customPropertyColorRatio: 0,
          mutationRate: 2.1,
        },
      },
      {
        name: 'only custom properties, no authored',
        facts: {
          ...base,
          customProperties: [
            {
              name: '--a',
              value: '#fff',
              color: whiteColor,
              usage: { background: 0, text: 0, border: 0, other: 0 },
            },
          ],
        },
        runtime: { mutationRate: 1 },
        expect: {
          authoredColorCount: 0,
          inlineStyleColorCount: 0,
          customPropertyColorRatio: 1,
          mutationRate: 1,
        },
      },
      {
        name: 'only authored colors, no custom properties',
        facts: {
          ...base,
          authoredRules: [
            {
              selector: 'body',
              property: 'color',
              value: '#fff',
              color: whiteColor,
              bucket: 'text',
              conditions: [],
            },
          ],
        },
        runtime: { mutationRate: 0 },
        expect: {
          authoredColorCount: 1,
          inlineStyleColorCount: 0,
          customPropertyColorRatio: 0,
          mutationRate: 0,
        },
      },
    ];

    for (const scenario of scenarios) {
      const metrics = deriveMetrics(scenario.facts as PageFacts, scenario.runtime);
      expect(metrics.authoredColorCount, `${scenario.name}: authoredColorCount`).toBe(
        scenario.expect.authoredColorCount,
      );
      expect(metrics.inlineStyleColorCount, `${scenario.name}: inlineStyleColorCount`).toBe(
        scenario.expect.inlineStyleColorCount,
      );
      expect(
        metrics.customPropertyColorRatio,
        `${scenario.name}: customPropertyColorRatio`,
      ).toBeCloseTo(scenario.expect.customPropertyColorRatio);
      expect(metrics.mutationRate, `${scenario.name}: mutationRate`).toBe(
        scenario.expect.mutationRate,
      );
    }
  });
});
