import { toHex } from '../color/parseColor';
import type { PageFacts } from './pageFacts';

export type PageMetrics = {
  colorCustomPropertyCount: number;
  domElementCount: number;
  shadowRootCount: number;
  unreadableStylesheetCount: number;
  unreadableStylesheetRatio: number;
  authoredColorCount: number;
  inlineStyleColorCount: number;
  customPropertyColorRatio: number;
  /** Callbacks per minute over the controller's rolling 60s observer window. */
  mutationRate: number;
};

// Metrics deriveMetrics can't compute from a PageFacts snapshot alone —
// mutationRate lives in the controller's rolling observer window, not the DOM.
export type RuntimeMetricsInput = { mutationRate: number };

export function deriveMetrics(facts: PageFacts, runtime: RuntimeMetricsInput): PageMetrics {
  const colorCustomPropertyCount = facts.customProperties.filter(
    (prop) => prop.color !== null,
  ).length;
  const inlineStyleColorCount = facts.inlineStyleColors.filter(
    (decl) => decl.color !== null,
  ).length;

  // Unique authored colors (by toHex) across authoredRules + inlineStyleColors.
  // pageFacts never appends custom-property declarations to authoredRules
  // (they belong to the variableRemap path, not this count) — see
  // collectRuleColors' `--` guard — so no property-name filter is needed here.
  const authoredColorSet = new Set<string>();
  for (const decl of [...facts.authoredRules, ...facts.inlineStyleColors]) {
    if (decl.color === null) continue;
    authoredColorSet.add(toHex(decl.color));
  }
  const authoredColorCount = authoredColorSet.size;

  // customPropertyColorRatio = colorCustomPropertyCount / max(1, authoredColorCount + colorCustomPropertyCount)
  const customPropertyColorRatio =
    colorCustomPropertyCount / Math.max(1, authoredColorCount + colorCustomPropertyCount);

  return {
    colorCustomPropertyCount,
    domElementCount: facts.domElementCount,
    shadowRootCount: facts.shadowRootCount,
    unreadableStylesheetCount: facts.unreadableStylesheetCount,
    unreadableStylesheetRatio:
      facts.stylesheetCount === 0 ? 0 : facts.unreadableStylesheetCount / facts.stylesheetCount,
    authoredColorCount,
    inlineStyleColorCount,
    customPropertyColorRatio,
    mutationRate: runtime.mutationRate,
  };
}
