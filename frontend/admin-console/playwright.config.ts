import { defineConfig, devices } from '@playwright/test';

// E2E (GD-14): runs the built console (`pnpm e2e` builds first) in Chromium on :3300 (GD-13). From AC4 on, suites
// that sign in (tests/e2e/signin.spec.ts) expect `pnpm dev` running in backend/ with the console's settings (README
// "End-to-end tests"); strict mode passes CARPAL_STRICT_AUTH=1 and CARPAL_ADMIN_CLIENT_PRIVATE_JWKS through.
const PORT = Number(process.env.CARPAL_E2E_PORT ?? 3300);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CARPAL_E2E_WORKERS ? Number(process.env.CARPAL_E2E_WORKERS) : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Same browser choice as the PWA (P13): the full Chromium in new headless mode, or CARPAL_E2E_CHROMIUM.
    ...(process.env.CARPAL_E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.CARPAL_E2E_CHROMIUM } } : { channel: 'chromium' }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      CARPAL_ADMIN_ENV: 'dev',
      CARPAL_ADMIN_ORIGIN: `http://localhost:${PORT}`,
      // The backend registers https redirect URIs only; the /id proxy brings the code back to http (OQ-11).
      CARPAL_ADMIN_OAUTH_REDIRECT_URI: `https://localhost:${PORT}/bff/oauth/callback`,
      CARPAL_STRICT_AUTH: process.env.CARPAL_STRICT_AUTH ?? '0',
      ...(process.env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS
        ? { CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: process.env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS }
        : {}),
    },
  },
});
