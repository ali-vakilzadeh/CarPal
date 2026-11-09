// AC4 unit tests of the shell's pure parts: role-filtered sections (GD-09), the idle deadline (AC4.T4) and the
// language/theme links.
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/lib/i18n/dictionary';
import { prefHref } from '@/lib/prefs';
import { DeadlineClock, endsAbsolutely, IDLE_WARNING_MS, idlePhase, signedOutUrl } from './idle';
import { roleNames } from './roles';
import { canOpen, rolesFor, SECTIONS, sectionBySlug, sectionOfPath, visibleSections } from './sections';

const ids = (roles: Parameters<typeof visibleSections>[0]) => visibleSections(roles).map((s) => s.id);

describe('navigation sections (GD-09)', () => {
  it('shows each role only the sections its operations allow', () => {
    expect(ids(['CRV'])).toEqual(['dashboard', 'reviews', 'disputes']);
    expect(ids(['SUP'])).toEqual(['dashboard', 'content', 'privacy', 'users', 'orgs', 'analytics']);
    expect(ids(['MOD'])).toEqual([
      'dashboard',
      'approvals',
      'verification',
      'reviews',
      'content',
      'inventory',
      'disputes',
      'users',
      'orgs',
      'taxonomy',
      'ai',
      'analytics',
    ]);
    // Contract 1.3.0: only MOD and CRV open disputes (OQ-10, "keep the contract").
    expect(ids(['ADM'])).not.toContain('disputes');
    expect(ids(['ADM'])).toEqual(expect.arrayContaining(['flags', 'rates', 'plans', 'retention', 'audit', 'mcp', 'staff']));
  });

  it('adds up the sections of several roles, and shows nothing without a staff role', () => {
    expect(ids(['MOD', 'CRV'])).toEqual(ids(['MOD']));
    expect(ids(['SUP', 'CRV'])).toEqual(['dashboard', 'reviews', 'content', 'disputes', 'privacy', 'users', 'orgs', 'analytics']);
    expect(ids([])).toEqual([]);
  });

  it('keeps ADM-only settings away from MOD, SUP and CRV', () => {
    for (const id of ['flags', 'rates', 'plans', 'retention', 'audit', 'mcp', 'staff'] as const) {
      const section = SECTIONS.find((s) => s.id === id)!;
      expect(rolesFor(section), id).toEqual(['ADM']);
      for (const role of ['MOD', 'SUP', 'CRV'] as const) expect(canOpen(section, [role]), `${role} ${id}`).toBe(false);
    }
  });

  it('finds the section of a path and of a slug', () => {
    expect(sectionOfPath('/')?.id).toBe('dashboard');
    expect(sectionOfPath('/flags?x=1')?.id).toBe('flags');
    expect(sectionOfPath('/users/0193/abc')?.id).toBe('users');
    expect(sectionOfPath('/nothing')).toBeUndefined();
    expect(sectionBySlug('rates')?.path).toBe('/rates');
    expect(sectionBySlug('')).toBeUndefined();
  });

  it('every section has a unique path and a label in both languages', () => {
    expect(new Set(SECTIONS.map((s) => s.path)).size).toBe(SECTIONS.length);
    for (const s of SECTIONS) {
      expect(getTranslator('en')(`admin.shell.nav.${s.id}`)).not.toContain('admin.');
      expect(getTranslator('fa')(`admin.shell.nav.${s.id}`)).not.toContain('admin.');
    }
  });

  it('names roles in the contract order', () => {
    expect(roleNames(['CRV', 'ADM'], getTranslator('en'))).toBe('Platform admin · Community reviewer');
  });
});

describe('idle deadline (AC4.T4)', () => {
  const view = (idle: string, server: string) => ({ idle_expires_at: idle, server_time: server });

  it("measures the time left on the browser's clock, whatever the server's clock says", () => {
    const clock = new DeadlineClock();
    // The server says 30 minutes are left; the browser's clock is an hour behind the server's.
    const now = Date.parse('2026-11-09T09:00:00Z');
    expect(clock.deadline(view('2026-11-09T10:30:00Z', '2026-11-09T10:00:00Z'), now)).toBe(now + 30 * 60_000);
  });

  it('keeps the deadline while the server reports the same one, and moves it when activity moved it', () => {
    const clock = new DeadlineClock();
    const t0 = 1_000_000;
    const first = clock.deadline(view('2026-11-09T10:30:00Z', '2026-11-09T10:00:00Z'), t0);
    // A minute later the view is re-read (not activity): same idle_expires_at, later server_time.
    expect(clock.deadline(view('2026-11-09T10:30:00Z', '2026-11-09T10:01:00Z'), t0 + 60_000)).toBe(first);
    // An API call moved the deadline on the server.
    expect(clock.deadline(view('2026-11-09T10:55:00Z', '2026-11-09T10:25:00Z'), t0 + 25 * 60_000)).toBe(t0 + 55 * 60_000);
    expect(clock.deadline(undefined, t0)).toBeNull();
  });

  it('takes the reported time left again after a confirmed "Stay signed in"', () => {
    const clock = new DeadlineClock();
    const same = view('2026-11-09T10:30:00Z', '2026-11-09T10:00:00Z');
    expect(clock.deadline(same, 0)).toBe(30 * 60_000);
    clock.reset();
    expect(clock.deadline(same, 25 * 60_000)).toBe(55 * 60_000);
  });

  it('warns 5 minutes before the end and ends at the deadline', () => {
    const deadline = 30 * 60_000;
    expect(idlePhase(deadline, 0)).toEqual({ phase: 'active' });
    expect(idlePhase(deadline, 25 * 60_000 - 1)).toEqual({ phase: 'active' });
    expect(idlePhase(deadline, 25 * 60_000)).toEqual({ phase: 'warning', leftMs: IDLE_WARNING_MS });
    expect(idlePhase(deadline, deadline)).toEqual({ phase: 'ended' });
    expect(idlePhase(null, 0)).toEqual({ phase: 'active' });
  });

  it('knows when the end is the 8-hour limit', () => {
    expect(endsAbsolutely({ idle_expires_at: 'a', expires_at: 'a' })).toBe(true);
    expect(endsAbsolutely({ idle_expires_at: 'a', expires_at: 'b' })).toBe(false);
  });

  it('builds the signed-out page URL with the return path', () => {
    expect(signedOutUrl('idle', '/flags?x=1')).toBe('/id/signed-out?reason=idle&return_to=%2Fflags%3Fx%3D1');
    expect(signedOutUrl('logout')).toBe('/id/signed-out?reason=logout');
    expect(signedOutUrl('ended', '/')).toBe('/id/signed-out?reason=ended');
  });
});

describe('language and theme links', () => {
  it('adds the choice to the current page and keeps the rest of the query', () => {
    expect(prefHref('/flags?tab=all', 'lang', 'fa')).toBe('/flags?tab=all&lang=fa');
    expect(prefHref('/', 'theme', 'dark')).toBe('/?theme=dark');
  });

  it('on a sign-in page, the authorize language follows the choice', () => {
    expect(prefHref('/id/signin?interaction_id=abc&ui_locales=en', 'lang', 'fa')).toBe(
      '/id/signin?interaction_id=abc&ui_locales=fa&lang=fa',
    );
  });
});
