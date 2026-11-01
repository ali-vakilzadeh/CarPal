import { defineConfig, devices } from '@playwright/test';

// E2E (GD-16): runs the built PWA (`pnpm e2e` builds first) in Chromium only (OQ-08). From P2 on, suites that need
// the backend expect `pnpm dev` running in backend/.
const PORT = Number(process.env.CARPAL_E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Four workers by default (P13): the key-flow, journey and accessibility suites are heavy, and more workers on one
  // machine turned their waits into timeouts. CARPAL_E2E_WORKERS overrides.
  workers: process.env.CARPAL_E2E_WORKERS ? Number(process.env.CARPAL_E2E_WORKERS) : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Strict mode (P13.T11): every ATT call is refused once, then a challenge is fetched and solved (≈ 2-4 s).
  ...(process.env.CARPAL_E2E_STRICT === '1' ? { expect: { timeout: 20_000 } } : {}),
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // A Chromium other than the one `pnpm e2e:install` downloads (e.g. a preinstalled browser of another Playwright
    // version in a CI image); unset = Playwright's own.
    // Otherwise the full Chromium in its new headless mode (P13): the headless shell answers Notification.permission
    // "denied" even after grantPermissions (Chromium 156), which hid the web push controls of pwa.spec.ts.
    ...(process.env.CARPAL_E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.CARPAL_E2E_CHROMIUM } } : { channel: 'chromium' }),
  },
  // Tests that change backend-wide state (feature flags) are tagged @global-flag and run after all others (P13).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@global-flag/ },
    { name: 'global-flags', use: { ...devices['Desktop Chrome'] }, grep: /@global-flag/, dependencies: ['chromium'] },
  ],
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
      // P13.T11: CARPAL_E2E_STRICT=1 runs against a backend started with CARPAL_STRICT_AUTH=1 (proof of work up front).
      CARPAL_STRICT_AUTH: process.env.CARPAL_E2E_STRICT === '1' ? '1' : '0',
      CARPAL_PWA_VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    },
  },
});
