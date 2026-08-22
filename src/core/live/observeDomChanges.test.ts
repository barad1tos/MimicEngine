// @vitest-environment happy-dom
// src/core/live/observeDomChanges.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STYLE_ELEMENT_ID, TRANSITION_KILL_ELEMENT_ID } from '../injector/styleElement';
import { observeDomChanges } from './observeDomChanges';

const DEBOUNCE_MS = 10;
const SETTLE_MS = 60;

afterEach(() => {
  document.documentElement.innerHTML = '';
});

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('observeDomChanges', () => {
  it('does not fire the callback when every mutation record in the batch is our own stylesheet write', async () => {
    const styleElement = document.createElement('style');
    styleElement.id = STYLE_ELEMENT_ID;
    document.documentElement.append(styleElement);

    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    styleElement.textContent = ':root { --pm-canvas: #000000; }';
    await waitFor(SETTLE_MS);

    expect(callback).not.toHaveBeenCalled();
    observer.stop();
  });

  it('fires the callback when a mutation targets something other than our style element', async () => {
    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    document.body.setAttribute('class', 'changed');
    await waitFor(SETTLE_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('fires once when a batch mixes our own write with an unrelated page mutation', async () => {
    const styleElement = document.createElement('style');
    styleElement.id = STYLE_ELEMENT_ID;
    document.documentElement.append(styleElement);

    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    styleElement.textContent = ':root { --pm-canvas: #000000; }';
    document.body.setAttribute('class', 'changed');
    await waitFor(SETTLE_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('does not fire the callback when a batch is solely the transition-kill element being added and removed', async () => {
    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    const killElement = document.createElement('style');
    killElement.id = TRANSITION_KILL_ELEMENT_ID;
    document.documentElement.append(killElement);
    killElement.remove();
    await waitFor(SETTLE_MS);

    expect(callback).not.toHaveBeenCalled();
    observer.stop();
  });

  it('fires once when a batch mixes the transition-kill element churn with an unrelated page mutation', async () => {
    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    const killElement = document.createElement('style');
    killElement.id = TRANSITION_KILL_ELEMENT_ID;
    document.documentElement.append(killElement);
    killElement.remove();
    document.body.setAttribute('class', 'changed');
    await waitFor(SETTLE_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('fires when the page itself removes our generated style element (self-heal path)', async () => {
    // A DOM sanitizer or aggressive page script stripping our style element
    // is PAGE activity, not our own churn: the debounced re-apply is the
    // only path that recreates the stylesheet, so this record must never be
    // swallowed by the own-churn exemption (which is for the transition-kill
    // element alone).
    const styleElement = document.createElement('style');
    styleElement.id = STYLE_ELEMENT_ID;
    document.documentElement.append(styleElement);
    await waitFor(SETTLE_MS);

    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    styleElement.remove();
    await waitFor(SETTLE_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('stops observing and cancels a pending debounce after stop()', async () => {
    const callback = vi.fn();
    const observer = observeDomChanges(callback, DEBOUNCE_MS);

    document.body.setAttribute('class', 'changed');
    observer.stop();
    await waitFor(SETTLE_MS);

    expect(callback).not.toHaveBeenCalled();
  });
});
