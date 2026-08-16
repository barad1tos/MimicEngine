// @vitest-environment happy-dom
// src/core/injector/shadowStyles.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtInThemes } from '../themes';
import {
  MAX_SHADOW_ROOTS,
  buildShadowStylesheet,
  collectOpenShadowRoots,
  removeShadowStylesheets,
  syncShadowStylesheets,
} from './shadowStyles';
import { STYLE_ELEMENT_ID } from './styleElement';

const theme = builtInThemes[0];

function attachOpenShadowHost(): { host: HTMLElement; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  return { host, shadowRoot };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectOpenShadowRoots', () => {
  it('finds every open shadow root under the given document', () => {
    const first = attachOpenShadowHost();
    const second = attachOpenShadowHost();

    const roots = collectOpenShadowRoots(document);

    expect(roots).toContain(first.shadowRoot);
    expect(roots).toContain(second.shadowRoot);
    expect(roots).toHaveLength(2);
  });

  it('caps collection at MAX_SHADOW_ROOTS by default', () => {
    for (let index = 0; index < MAX_SHADOW_ROOTS + 5; index += 1) {
      attachOpenShadowHost();
    }

    const roots = collectOpenShadowRoots(document);

    expect(roots).toHaveLength(MAX_SHADOW_ROOTS);
  });

  it('respects an explicit maxRoots smaller than the default cap', () => {
    attachOpenShadowHost();
    attachOpenShadowHost();
    attachOpenShadowHost();

    const roots = collectOpenShadowRoots(document, 2);

    expect(roots).toHaveLength(2);
  });

  it('never collects closed shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'closed' });

    const roots = collectOpenShadowRoots(document);

    expect(roots).toHaveLength(0);
  });
});

describe('buildShadowStylesheet', () => {
  it('is deterministic for the same theme', () => {
    expect(buildShadowStylesheet(theme)).toBe(buildShadowStylesheet(theme));
  });

  it('scopes token declarations to :host', () => {
    expect(buildShadowStylesheet(theme)).toContain(':host');
  });

  it('never carries the document activation gate (stripped, not merely hidden)', () => {
    expect(buildShadowStylesheet(theme)).not.toContain('html[data-pm-active');
  });
});

describe('syncShadowStylesheets', () => {
  it('creates the style element once per root', () => {
    const { shadowRoot } = attachOpenShadowHost();
    const css = buildShadowStylesheet(theme);

    syncShadowStylesheets(css, [shadowRoot]);

    const element = shadowRoot.getElementById(STYLE_ELEMENT_ID);
    expect(element).toBeInstanceOf(HTMLStyleElement);
    expect(element?.textContent).toBe(css);
  });

  it("creates the style element from the root's own document, not the module-global document", () => {
    const { shadowRoot } = attachOpenShadowHost();

    syncShadowStylesheets(buildShadowStylesheet(theme), [shadowRoot]);

    const element = shadowRoot.getElementById(STYLE_ELEMENT_ID);
    expect(element?.ownerDocument).toBe(shadowRoot.ownerDocument);
  });

  it('identity-skips the write when css is unchanged across two syncs', () => {
    const { shadowRoot } = attachOpenShadowHost();
    const css = buildShadowStylesheet(theme);
    syncShadowStylesheets(css, [shadowRoot]);

    const textContentSetter = vi.spyOn(Node.prototype, 'textContent', 'set');
    syncShadowStylesheets(css, [shadowRoot]);

    expect(textContentSetter).not.toHaveBeenCalled();
    textContentSetter.mockRestore();
  });

  it('rewrites the element when css changes', () => {
    const { shadowRoot } = attachOpenShadowHost();
    syncShadowStylesheets(buildShadowStylesheet(theme), [shadowRoot]);

    const changed = `${buildShadowStylesheet(theme)}\n/* changed */`;
    syncShadowStylesheets(changed, [shadowRoot]);

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)?.textContent).toBe(changed);
  });
});

describe('removeShadowStylesheets', () => {
  it('removes the style element from every open shadow root', () => {
    const first = attachOpenShadowHost();
    const second = attachOpenShadowHost();
    const css = buildShadowStylesheet(theme);
    syncShadowStylesheets(css, [first.shadowRoot, second.shadowRoot]);

    removeShadowStylesheets(document);

    expect(first.shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    expect(second.shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });

  it('clears every root even beyond the normal sync cap', () => {
    const roots: ShadowRoot[] = [];
    for (let index = 0; index < MAX_SHADOW_ROOTS + 3; index += 1) {
      roots.push(attachOpenShadowHost().shadowRoot);
    }
    // Synced directly against the full list (bypassing the 32-cap collect)
    // so the assertion below proves removeShadowStylesheets' own collection
    // pass uses a cap larger than MAX_SHADOW_ROOTS, not that sync happened
    // to cover them all.
    syncShadowStylesheets(buildShadowStylesheet(theme), roots);

    removeShadowStylesheets(document);

    for (const shadowRoot of roots) {
      expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
    }
  });
});
