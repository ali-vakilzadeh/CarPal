// Shared Playwright helpers (copied from pwa/tests/e2e/support.ts, trimmed): axe on visited pages and a wait for
// hydration (data-hydrated on <html>, set by AppProviders).
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

export async function gotoReady(page: Page, url: string) {
  const response = await page.goto(url);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  return response;
}
