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
