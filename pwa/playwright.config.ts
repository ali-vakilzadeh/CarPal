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
    // A Chromium other than the one `pnpm e2e:install` downloads (e.g. a preinstalled browser of another Playwright
    // version in a CI image); unset = Playwright's own.
    ...(process.env.CARPAL_E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.CARPAL_E2E_CHROMIUM } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/fa`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // CARPAL_PWA_DEMO exposes /<locale>/dev-kit (P3 pattern and status checks) and the worker's cp_sw_salt (P12 update
    // flow); never set in prod (env.ts refuses it).
    // CARPAL_PWA_OAUTH_REDIRECT_URI: the backend registers https redirect URIs only (DI-24); the /id proxy brings the
    // code back to this http origin, so the browser never needs TLS (OQ-10, pwa/README.md "Sign-in in development").
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      CARPAL_PWA_ORIGIN: `http://localhost:${PORT}`,
      CARPAL_PWA_DEMO: '1',
      CARPAL_PWA_OAUTH_REDIRECT_URI: `https://localhost:${PORT}/bff/oauth/callback`,
      // P12 web push: a public VAPID key so the push controls appear; the E2E stubs the Push API (no push service).
      CARPAL_PWA_VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    },
  },
});
