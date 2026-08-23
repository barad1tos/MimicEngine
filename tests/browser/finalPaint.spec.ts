import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';

const EXTENSION_PATH = path.resolve('.output/chrome-mv3');
const SETTINGS_KEY = 'palette-mimicry:settings';
const PLAN_KEY = 'palette-mimicry:plan:outcome.test';

type ChromeStorage = {
  chrome: {
    storage: {
      local: { set: (items: Record<string, object>) => Promise<void> };
      session: { get: (key: string) => Promise<Record<string, object>> };
    };
  };
};

const AYU_SETTINGS = {
  schemaVersion: 2,
  globalThemeId: 'ayu-mirage',
  sites: {
    'outcome.test': {
      enabled: true,
      themeId: 'ayu-mirage',
      strategy: 'baseline',
      preserveImages: true,
      preserveBrandColors: true,
      overrides: [],
    },
  },
} as const;

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
}

test('applies Ayu final paint from the production extension', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  try {
    const serviceWorker = await waitForServiceWorker(context);
    await serviceWorker.evaluate(
      ({ settingsKey, settings }) => {
        const { chrome } = globalThis as typeof globalThis & ChromeStorage;
        return chrome.storage.local.set({ [settingsKey]: settings });
      },
      { settingsKey: SETTINGS_KEY, settings: AYU_SETTINGS },
    );

    await context.route('https://outcome.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main>Readable text</main></body></html>',
      }),
    );

    const page = await context.newPage();
    await page.goto('https://outcome.test/');

    await expect
      .poll(() =>
        serviceWorker.evaluate((planKey) => {
          const { chrome } = globalThis as typeof globalThis & ChromeStorage;
          return chrome.storage.session
            .get(planKey)
            .then((stored) => Object.hasOwn(stored, planKey));
        }, PLAN_KEY),
      )
      .toBe(true);

    await expect(page.locator('html')).toHaveAttribute('data-pm-active', 'true');
    await expect(page.locator('#palette-mimicry-generated-style')).not.toBeEmpty();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 36, 48)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(203, 204, 198)');
  } finally {
    await context.close();
  }
});
