import { createPageThemeController } from '../src/core/runtime/pageThemeController';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    const controller = createPageThemeController();
    window.addEventListener(
      'pagehide',
      () => {
        controller.stop();
      },
      { once: true },
    );

    await controller.start();
  },
});
