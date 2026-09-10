import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import path from 'node:path';

const EXTENSION_PATH = path.resolve('.output/chrome-mv3');
const SETTINGS_KEY = 'palette-mimicry:settings';

const TRANSPARENT_BORDER = 'rgba(0, 0, 0, 0)';
const TRANSLUCENT_BORDER = 'rgba(12, 34, 56, 0.35)';
const VISIBLE_BORDER = 'rgb(14, 87, 65)';
const THEME_BORDER = 'rgb(52, 63, 74)';
const THEME_DANGER = 'rgb(255, 102, 102)';
const THEME_FOCUS = 'rgb(92, 207, 230)';

type ChromeStorage = {
  chrome: {
    storage: {
      local: { set: (items: Record<string, object>) => Promise<void> };
    };
  };
};

const AYU_SETTINGS = {
  schemaVersion: 2,
  globalThemeId: 'ayu-mirage',
  sites: {
    'border-baseline.test': {
      enabled: true,
      themeId: 'ayu-mirage',
      strategy: 'baseline',
      preserveImages: true,
      preserveBrandColors: false,
      overrides: [{ selector: '#overridden-control', property: 'border-color', token: 'danger' }],
    },
    'border-source.test': {
      enabled: true,
      themeId: 'ayu-mirage',
      strategy: 'authoredRemap',
      preserveImages: true,
      preserveBrandColors: false,
      overrides: [],
    },
    'border-shadow.test': {
      enabled: true,
      themeId: 'ayu-mirage',
      strategy: 'deepRemap',
      preserveImages: true,
      preserveBrandColors: false,
      overrides: [],
    },
  },
} as const;

const BASELINE_DOCUMENT = `<!doctype html>
  <html>
    <head>
      <style>
        #transparent-control { border: 1px solid rgba(0, 0, 0, 0); }
        #translucent-surface { border: 1px solid rgba(12, 34, 56, 0.35); }
        #visible-code { border: 1px solid rgb(14, 87, 65); }
        #focus-control { border: 1px solid transparent; outline: none; }
        #overridden-control { border: 1px solid transparent; }
      </style>
    </head>
    <body>
      <button id="transparent-control">Transparent control</button>
      <section id="translucent-surface">Translucent surface</section>
      <code id="visible-code">Visible border</code>
      <button id="focus-control">Focus control</button>
      <button id="overridden-control">Explicit override</button>
    </body>
  </html>`;

const SOURCE_AWARE_DOCUMENT = `<!doctype html>
  <html>
    <head>
      <style>.mapped-border { border: 2px solid rgb(58, 58, 68); }</style>
    </head>
    <body><div class="mapped-border">Mapped border</div></body>
  </html>`;

const SHADOW_DOCUMENT = `<!doctype html>
  <html>
    <body>
      <div id="shadow-host"></div>
      <script>
        const shadowRoot = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
        shadowRoot.innerHTML = \`
          <style>
            #shadow-transparent { border: 1px solid rgba(0, 0, 0, 0); }
            #shadow-translucent { border: 1px solid rgba(12, 34, 56, 0.35); }
          </style>
          <button id="shadow-transparent">Transparent shadow control</button>
          <section id="shadow-translucent">Translucent shadow surface</section>
        \`;
      </script>
    </body>
  </html>`;

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

async function openThemedPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-pm-active', 'true');
  await expect(page.locator('html > #palette-mimicry-generated-style')).not.toBeEmpty();
  return page;
}

test('preserves authored border paint while explicit and source-aware rules still recolor it', async () => {
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

    await context.route('https://border-baseline.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: BASELINE_DOCUMENT }),
    );
    await context.route('https://border-source.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: SOURCE_AWARE_DOCUMENT }),
    );
    await context.route('https://border-shadow.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: SHADOW_DOCUMENT }),
    );

    const baselinePage = await openThemedPage(context, 'https://border-baseline.test/');
    await expect
      .soft(baselinePage.locator('#transparent-control'))
      .toHaveCSS('border-color', TRANSPARENT_BORDER);
    await expect
      .soft(baselinePage.locator('#translucent-surface'))
      .toHaveCSS('border-color', TRANSLUCENT_BORDER);
    await expect
      .soft(baselinePage.locator('#visible-code'))
      .toHaveCSS('border-color', VISIBLE_BORDER);
    await expect(baselinePage.locator('#overridden-control')).toHaveCSS(
      'border-color',
      THEME_DANGER,
    );

    const focusControl = baselinePage.locator('#focus-control');
    await focusControl.focus();
    await expect(focusControl).toHaveCSS('outline-style', 'solid');
    await expect(focusControl).toHaveCSS('outline-width', '2px');
    await expect(focusControl).toHaveCSS('outline-color', THEME_FOCUS);

    const sourcePage = await openThemedPage(context, 'https://border-source.test/');
    await expect
      .poll(() => sourcePage.locator('html > #palette-mimicry-generated-style').textContent())
      .toContain('border-top-color: #343f4a !important;');
    await expect(sourcePage.locator('.mapped-border')).toHaveCSS('border-color', THEME_BORDER);

    const shadowPage = await openThemedPage(context, 'https://border-shadow.test/');
    const shadowHost = shadowPage.locator('#shadow-host');
    await expect
      .poll(() =>
        shadowHost.evaluate((host) =>
          Boolean(host.shadowRoot?.getElementById('palette-mimicry-generated-style')),
        ),
      )
      .toBe(true);
    await expect
      .soft(shadowHost.locator('#shadow-transparent'))
      .toHaveCSS('border-color', TRANSPARENT_BORDER);
    await expect
      .soft(shadowHost.locator('#shadow-translucent'))
      .toHaveCSS('border-color', TRANSLUCENT_BORDER);
  } finally {
    await context.close();
  }
});
