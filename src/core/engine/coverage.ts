import type { ColorMapping, SitePaletteEntry } from './colorMap';

export type CoverageReport = {
  discovered: number;
  mapped: number;
  // mapped / discovered, always constructed by computeCoverage — never set
  // independently, and defined as 0 (not NaN) when discovered is 0.
  ratio: number;
};

/**
 * Measures how much of the discovered site palette a color mapping actually
 * covers. `ratio` is `mapped / discovered`, except when nothing was
 * discovered at all (`discovered === 0`), where it's defined as 0 rather
 * than `NaN` — an empty palette reads as "nothing covered", not "fully
 * covered" or "undefined".
 *
 * @example computeCoverage([], new Map()) // { discovered: 0, mapped: 0, ratio: 0 }
 */
export function computeCoverage(
  palette: SitePaletteEntry[],
  mapping: ColorMapping,
): CoverageReport {
  const discovered = palette.length;
  const mapped = palette.filter((entry) => mapping.has(entry.hex)).length;
  const ratio = discovered === 0 ? 0 : mapped / discovered;

  return { discovered, mapped, ratio };
}

/**
 * Merges per-strategy coverage reports into one aggregate: discovered and
 * mapped are summed, then `ratio` is recomputed from those sums (not
 * averaged) — the same discovered===0 -> 0 rule as computeCoverage. Returns
 * undefined when no strategy in the plan reported coverage at all, so
 * callers can omit the diagnostics field entirely instead of writing a
 * zeroed-out report for a plan that had nothing to measure.
 *
 * @example aggregateCoverage([]) // undefined
 * @example aggregateCoverage([{ discovered: 10, mapped: 8, ratio: 0.8 }, { discovered: 5, mapped: 1, ratio: 0.2 }])
 * // { discovered: 15, mapped: 9, ratio: 0.6 }
 */
export function aggregateCoverage(reports: readonly CoverageReport[]): CoverageReport | undefined {
  if (reports.length === 0) return undefined;

  const discovered = reports.reduce((sum, report) => sum + report.discovered, 0);
  const mapped = reports.reduce((sum, report) => sum + report.mapped, 0);
  const ratio = discovered === 0 ? 0 : mapped / discovered;

  return { discovered, mapped, ratio };
}

/**
 * CoverageReport from raw counts — the census path's honest form, where the
 * denominator (colors seen on the page) is wider than the mapped palette.
 * Same discovered===0 -> ratio 0 rule as computeCoverage.
 *
 * @example coverageFromCounts(0, 0) // { discovered: 0, mapped: 0, ratio: 0 }
 */
export function coverageFromCounts(discovered: number, mapped: number): CoverageReport {
  return { discovered, mapped, ratio: discovered === 0 ? 0 : mapped / discovered };
}
