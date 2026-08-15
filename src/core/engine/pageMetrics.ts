import type { PageFacts } from './pageFacts';

export type PageMetrics = {
  colorCustomPropertyCount: number;
  domElementCount: number;
  shadowRootCount: number;
  unreadableStylesheetRatio: number;
};

export function deriveMetrics(facts: PageFacts): PageMetrics {
  return {
    colorCustomPropertyCount: facts.customProperties.filter((prop) => prop.color !== null).length,
    domElementCount: facts.domElementCount,
    shadowRootCount: facts.shadowRootCount,
    unreadableStylesheetRatio:
      facts.styleSheetCount === 0 ? 0 : facts.unreadableStyleSheetCount / facts.styleSheetCount,
  };
}
