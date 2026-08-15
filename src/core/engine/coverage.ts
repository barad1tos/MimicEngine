import type { ColorMapping } from './colorMap';
import type { SitePaletteEntry } from './colorMap';

export type CoverageReport = {
  discovered: number;
  mapped: number;
  ratio: number;
};

export function computeCoverage(
  palette: SitePaletteEntry[],
  mapping: ColorMapping,
): CoverageReport {
  const discovered = palette.length;
  const mapped = palette.filter((entry) => mapping.has(entry.hex)).length;
  const ratio = discovered === 0 ? 0 : mapped / discovered;

  return { discovered, mapped, ratio };
}
