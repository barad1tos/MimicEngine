export default defineBackground(() => {
  const warnAccessLevelFailure = (error: unknown): void => {
    console.warn(
      '[Palette Mimicry] failed to grant content scripts access to storage.session',
      error,
    );
  };

  // Content scripts run in an untrusted context; without this, writes to
  // storage.session from pageThemeController throw in Chromium. Firefox may
  // not implement setAccessLevel at all, hence the existence check below.
  if (typeof browser.storage.session.setAccessLevel !== 'function') {
    warnAccessLevelFailure(new Error('browser.storage.session.setAccessLevel is unavailable'));
    return;
  }

  browser.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(warnAccessLevelFailure);
});
