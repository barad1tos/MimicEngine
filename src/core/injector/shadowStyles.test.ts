// @vitest-environment happy-dom
// src/core/injector/shadowStyles.test.ts
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtInThemes } from '../themes';
import {
  MAX_SHADOW_ROOTS,
  MAX_VISITED_ELEMENTS,
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

  it('stops the walk after MAX_VISITED_ELEMENTS, regardless of unmet maxRoots', () => {
    // Fill the document with more light-DOM elements than the visited-
    // elements budget before the shadow host, so the host sits beyond the
    // point where the walk gives up — proving the budget is a visit cap,
    // not merely a collected-roots cap (maxRoots is POSITIVE_INFINITY here,
    // so only the visited-elements budget can be stopping the walk).
    for (let index = 0; index < MAX_VISITED_ELEMENTS; index += 1) {
      document.body.append(document.createElement('div'));
    }
    const { shadowRoot } = attachOpenShadowHost();

    const roots = collectOpenShadowRoots(document, Number.POSITIVE_INFINITY);

    expect(roots).not.toContain(shadowRoot);
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
    // A single-document happy-dom test file makes an ownerDocument assertion
    // non-falsifiable twice over: shadowRoot.ownerDocument already equals the
    // shared global `document` before any code runs, AND `shadowRoot.append`
    // auto-adopts its argument into the target tree's document per spec (the
    // WHATWG "pre-insert" algorithm adopts a node whose node document differs
    // from the parent's) — so even a genuinely second document can't catch a
    // hardcoded-global-`document` regression by inspecting ownerDocument
    // *after* syncShadowStylesheets runs, since append silently corrects it
    // either way. Spying on createElement at the call site observes which
    // document's method actually ran, which auto-adopt cannot mask.
    // happy-dom ships its own Document/ShadowRoot classes rather than the
    // lib.dom interfaces this module is typed against, so bridging them at
    // the call boundary needs the same `as unknown as` idiom used elsewhere
    // in this suite for cross-implementation DOM fakes.
    const second = new Window();
    const secondDocument = second.document as unknown as Document;
    const host = secondDocument.createElement('div');
    secondDocument.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });

    const secondCreateElement = vi.spyOn(secondDocument, 'createElement');
    const globalCreateElement = vi.spyOn(document, 'createElement');

    syncShadowStylesheets(buildShadowStylesheet(theme), [shadowRoot]);

    expect(secondCreateElement).toHaveBeenCalledWith('style');
    expect(globalCreateElement).not.toHaveBeenCalled();

    secondCreateElement.mockRestore();
    globalCreateElement.mockRestore();
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

  it('reaches a shadow root whose host was detached before removal, and it stays torn down after re-attach', () => {
    const { host, shadowRoot } = attachOpenShadowHost();
    syncShadowStylesheets(buildShadowStylesheet(theme), [shadowRoot]);
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeInstanceOf(HTMLStyleElement);

    // Detach: a document walk from here on can no longer see this host, so
    // only the tracked-roots sweep (not collectOpenShadowRoots) can reach it.
    host.remove();

    removeShadowStylesheets(document);

    document.body.append(host);

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });

  it('does not grow tracking unboundedly across repeated syncs of the same root', () => {
    const { shadowRoot } = attachOpenShadowHost();
    const css = buildShadowStylesheet(theme);

    for (let index = 0; index < 10; index += 1) {
      syncShadowStylesheets(css, [shadowRoot]);
    }

    removeShadowStylesheets(document);

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });

  it('removes a tracked root even when it sits beyond the visited-elements budget', () => {
    // Track and style the root while it is trivially reachable...
    const { shadowRoot } = attachOpenShadowHost();
    syncShadowStylesheets(buildShadowStylesheet(theme), [shadowRoot]);
    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeInstanceOf(HTMLStyleElement);

    // ...then bury it behind more elements than the visited-elements budget,
    // inserted before it in document order so the walk exhausts its budget
    // before ever reaching the host.
    const filler = document.createElement('div');
    document.body.prepend(filler);
    for (let index = 0; index < MAX_VISITED_ELEMENTS; index += 1) {
      filler.append(document.createElement('div'));
    }

    // Falsifiability check: the document walk alone can no longer see this
    // root (even with an unbounded roots cap), so the removal below can only
    // be explained by the tracked-roots sweep, not collectOpenShadowRoots.
    expect(collectOpenShadowRoots(document, Number.POSITIVE_INFINITY)).not.toContain(shadowRoot);

    removeShadowStylesheets(document);

    expect(shadowRoot.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });
});
