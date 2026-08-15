// src/core/engine/strategies/emitGroupedRules.test.ts
import { describe, expect, it } from 'vitest';
import { emitGroupedRules } from './emitGroupedRules';

function groupsOf(
  selector: string,
  declarations: Record<string, string>,
): Map<string, Map<string, string>> {
  return new Map([[selector, new Map(Object.entries(declarations))]]);
}

describe('emitGroupedRules — html/:root grafting', () => {
  it('grafts the gate onto an html-rooted compound selector instead of prefixing it', () => {
    const css = emitGroupedRules(groupsOf('html.dark .x', { color: '#fff' }));

    expect(css).toContain('html[data-pm-active="true"].dark .x {');
  });

  it('collapses bare :root onto the gate with no trailing space', () => {
    const css = emitGroupedRules(groupsOf(':root', { color: '#fff' }));

    expect(css.startsWith('html[data-pm-active="true"] {')).toBe(true);
  });

  it('collapses bare html onto the gate with no trailing space', () => {
    const css = emitGroupedRules(groupsOf('html', { color: '#fff' }));

    expect(css.startsWith('html[data-pm-active="true"] {')).toBe(true);
  });

  it('keeps the plain descendant-combinator prefix for a normal selector', () => {
    const css = emitGroupedRules(groupsOf('.card', { color: '#fff' }));

    expect(css.startsWith('html[data-pm-active="true"] .card {')).toBe(true);
  });

  it('does not graft a tag name that merely starts with "html" (token-boundary check)', () => {
    const css = emitGroupedRules(groupsOf('html-widget', { color: '#fff' }));

    expect(css.startsWith('html[data-pm-active="true"] html-widget {')).toBe(true);
  });
});
