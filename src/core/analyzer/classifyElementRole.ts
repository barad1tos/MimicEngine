import type { ComputedColorSample } from './collectComputedColors';
import type { RoleClassification } from '../mapper/semanticRoles';

export function classifyElementRole(sample: ComputedColorSample): RoleClassification {
  if (sample.property === 'color' && sample.textLength > 0) {
    if (sample.tagName === 'a') {
      return { role: 'link', confidence: 0.75, reasons: ['foreground color on anchor element'] };
    }

    return { role: 'text', confidence: 0.6, reasons: ['foreground color on text-bearing element'] };
  }

  if (sample.property === 'backgroundColor') {
    return { role: 'surface', confidence: 0.45, reasons: ['background color'] };
  }

  if (sample.property === 'borderTopColor') {
    return { role: 'border', confidence: 0.55, reasons: ['border color'] };
  }

  return { role: 'unknown', confidence: 0, reasons: [] };
}
