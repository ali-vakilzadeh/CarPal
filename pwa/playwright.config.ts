import { defineConfig, devices } from '@playwright/test';

// E2E (GD-16): runs the built PWA (`pnpm e2e` builds first) in Chromium only (OQ-08). From P2 on, suites that need
// the backend expect `pnpm dev` running in backend/.
const PORT = Number(process.env.CARPAL_E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/fa`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { NEXT_TELEMETRY_DISABLED: '1', CARPAL_PWA_ORIGIN: `http://localhost:${PORT}` },
  },
});
