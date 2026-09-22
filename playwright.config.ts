import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4186);
const baseURL = `http://127.0.0.1:${port}`;
const staticOnly = process.env.PLAYWRIGHT_STATIC === '1';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: staticOnly
      ? `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`
      : 'npm run dev',
    url: staticOnly ? baseURL : `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(port), TYPESAFE_API_KEY: '', JEV_OFFLINE: '1' },
    timeout: 30_000,
  },
});
