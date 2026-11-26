import { defineConfig } from '@playwright/test';
const webkit = process.env.LWPDF_BROWSER === 'webkit';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    browserName: webkit ? 'webkit' : 'chromium',
    viewport: { width: 1180, height: 820 },
    launchOptions: webkit
      ? {}
      : {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE === ''
              ? undefined
              : (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium'),
          args: ['--no-sandbox'],
        },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
