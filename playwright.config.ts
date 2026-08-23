import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.output/playwright',
  workers: 1,
  reporter: 'line',
  use: {
    trace: 'retain-on-failure',
  },
});
