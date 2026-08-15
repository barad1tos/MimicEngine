import { toHex } from '../color/parseColor';
import type { PageFacts } from './pageFacts';

export type PageMetrics = {
  colorCustomPropertyCount: number;
  domElementCount: number;
  shadowRootCount: number;
  unreadableStylesheetRatio: number;
  authoredColorCount: number;
  inlineStyleColorCount: number;
  customPropertyColorRatio: number;
  /** Callbacks per minute over the controller's rolling 60s observer window. */
  mutationRate: number;
};

export function deriveMetrics(facts: PageFacts, runtime: { mutationRate: number }): PageMetrics {
  const colorCustomPropertyCount = facts.customProperties.filter(
    (prop) => prop.color !== null,
  ).length;
  const inlineStyleColorCount = facts.inlineStyleColors.filter(
    (decl) => decl.color !== null,
  ).length;

  // Unique authored colors (by toHex) across authoredRules + inlineStyleColors.
  // Custom-property declarations (property starting with `--`) are excluded —
  // same predicate colorMap.ts uses to keep them out of the literal palette —
  // since they belong to the variableRemap path, not the authored-color count.
  const authoredColorSet = new Set<string>();
  for (const decl of [...facts.authoredRules, ...facts.inlineStyleColors]) {
    if (decl.color === null) continue;
    if (decl.property.startsWith('--')) continue;
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
    unreadableStylesheetRatio:
      facts.styleSheetCount === 0 ? 0 : facts.unreadableStyleSheetCount / facts.styleSheetCount,
    authoredColorCount,
    inlineStyleColorCount,
    customPropertyColorRatio,
    mutationRate: runtime.mutationRate,
  };
}
