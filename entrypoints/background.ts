export default defineBackground(() => {
  const warnAccessFailure = (error: unknown): void => {
    console.warn(
      '[Palette Mimicry] failed to grant content scripts access to storage.session',
      error,
    );
  };

  // Content scripts run in an untrusted context; without this, writes to
  // storage.session from pageThemeController throw in Chromium. Firefox may
  // not implement setAccessLevel at all, hence the existence check below.
  // storage.session itself can also be missing entirely at runtime on older
  // or non-compliant browsers, even though @wxt-dev/browser's ambient types
  // (matching the full WebExtension spec surface) declare it as always
  // present — optional-chain into it so that case falls through to the warn
  // branch instead of throwing on the property read.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards a real runtime gap the ambient types don't model, see comment above
  if (typeof browser.storage?.session?.setAccessLevel === 'function') {
    browser.storage.session
      .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
      .catch(warnAccessFailure);
  } else {
    warnAccessFailure(new Error('browser.storage.session.setAccessLevel is unavailable'));
  }
});
