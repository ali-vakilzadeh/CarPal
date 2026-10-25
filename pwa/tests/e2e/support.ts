// Shared Playwright helpers: axe on every visited page, consent pre-set (so the banner does not cover the page in
// layout checks), and the layout invariants of P3 (no horizontal scroll).
import AxeBuilder from '@axe-core/playwright';
import { expect, type BrowserContext, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** Pre-sets the cookie choice (Reject non-essential) so the first-visit banner stays closed. */
export async function decideCookies(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: 'cp_consent', value: 'v1.a0', url: baseURL }]);
}

export async function setTheme(context: BrowserContext, baseURL: string, theme: 'light' | 'sun' | 'dark') {
  await context.addCookies([{ name: 'cp_theme', value: theme, url: baseURL }]);
}

/** Navigates and waits until React hydrated (data-hydrated on <html>), so clicks reach the handlers. */
export async function gotoReady(page: Page, url: string) {
  const response = await page.goto(url);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  return response;
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
