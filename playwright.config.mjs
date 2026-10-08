import { defineConfig, devices } from '@playwright/test';

// Browser E2E against the real API + fake Sarvam/Gemini + Vite. No provider keys, no spend.
// Add specs under tests/e2e/browser/*.spec.mjs; fixtures for the stack are in tests/e2e/helpers/.
const apiPort = Number(process.env.E2E_API_PORT ?? 8887);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);

export default defineConfig({
  testDir: 'tests/e2e/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'mobile-360', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 } } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/helpers/serve-stack.mjs',
      env: { E2E_API_PORT: String(apiPort), E2E_WEB_PORT: String(webPort) },
      port: apiPort,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: `node node_modules/vite/bin/vite.js --config tests/e2e/vite.e2e.config.mjs --strictPort`,
      env: { E2E_API_PORT: String(apiPort), E2E_WEB_PORT: String(webPort) },
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
