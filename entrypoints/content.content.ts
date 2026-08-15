import { createPageThemeController } from '../src/core/runtime/pageThemeController';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    const controller = createPageThemeController();
    await controller.start();

    window.addEventListener(
      'pagehide',
      () => {
        controller.stop();
      },
      { once: true },
    );
  },
});
