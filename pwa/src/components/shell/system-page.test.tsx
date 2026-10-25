// P3.T8: W-SYS-01 system page bodies (the statuses are covered by the proxy, system-status and e2e tests).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/lib/i18n/dictionary';
import { SYSTEM_STATUS, SystemPage, maintenanceText } from './system-page';

const fa = getTranslator('fa');
const en = getTranslator('en');

describe('SystemPage', () => {
  it('statuses per Docs/22 W-SYS-01', () => {
    expect(SYSTEM_STATUS).toEqual({ 'not-found': 404, gone: 410, suspended: 200, 'no-access': 403, maintenance: 503 });
  });

  it('not found: search and home, in Persian', () => {
    render(<SystemPage kind="not-found" locale="fa" t={fa} />);
    expect(screen.getByRole('heading', { level: 1, name: 'این صفحه وجود ندارد' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'رفتن به صفحه اصلی' })).toHaveAttribute('href', '/fa');
    expect(screen.getByRole('link', { name: 'جستجو در کارپال' })).toHaveAttribute('href', '/fa#search');
  });

  it('removed content shows no reason; suspended offers other specialists; no access offers switch account', () => {
    const { unmount } = render(<SystemPage kind="gone" locale="en" t={en} />);
    expect(screen.getByRole('heading', { name: 'This post is no longer available' })).toBeInTheDocument();
    unmount();
    const s = render(<SystemPage kind="suspended" locale="en" t={en} />);
    expect(screen.getByRole('link', { name: 'Find other specialists' })).toBeInTheDocument();
    s.unmount();
    render(<SystemPage kind="no-access" locale="en" t={en} />);
    expect(screen.getByRole('link', { name: 'Switch account' }).getAttribute('href')).toContain('/bff/login?return_to=%2Fen');
  });

  it('maintenance shows the time estimate in the UI calendar', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    expect(maintenanceText('2026-10-25T11:30:00Z', 'fa', fa, 'UTC', now)).toBe('انتظار داریم حدود ساعت ۱۱:۳۰ برگردیم.');
    expect(maintenanceText(null, 'en', en, 'UTC', now)).toBe('We will be back shortly. Thank you for your patience.');
    expect(maintenanceText('2026-10-27T09:00:00Z', 'en', en, 'UTC', now)).toContain('Oct 27, 2026');
    render(<SystemPage kind="maintenance" locale="en" t={en} />);
    expect(screen.getByRole('heading', { name: 'CarPal is being updated' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
