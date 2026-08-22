import type { CoverageReport } from './coverage';

export type StyleSection = {
  css: string;
  coverage?: CoverageReport;
};

export type StylePlan = {
  sections: readonly StyleSection[];
};

export function emitStylePlan(plan: StylePlan): {
  css: string;
  coverages: CoverageReport[];
} {
  const css = plan.sections
    .map((section) => section.css)
    .filter((section) => section.length > 0)
    .join('\n\n')
    .trim();
  const coverages = plan.sections.flatMap((section) =>
    section.coverage ? [section.coverage] : [],
  );

  return { css, coverages };
}
