// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { waitForDocumentReady } from './documentReady';

describe('waitForDocumentReady', () => {
  it.each(['interactive', 'complete'] as const)(
    'resolves immediately when document is %s',
    async (readyState) => {
      vi.spyOn(document, 'readyState', 'get').mockReturnValue(readyState);

      await expect(waitForDocumentReady(document)).resolves.toBeUndefined();
    },
  );

  it('waits for one DOMContentLoaded event while document is loading', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    let didResolve = false;

    const ready = waitForDocumentReady(document).then(() => {
      didResolve = true;
    });
    await Promise.resolve();
    expect(didResolve).toBe(false);

    document.dispatchEvent(new Event('DOMContentLoaded'));
    await ready;
    expect(didResolve).toBe(true);

    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(didResolve).toBe(true);
  });
});
