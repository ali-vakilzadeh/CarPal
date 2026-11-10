// AC4.T3-T7 DOM tests of the console shell: role-filtered navigation, keyboard shortcuts, the idle warning, the
// session end, and step-up with a one-time replay of the saved action.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { ApiProvider, createQueryClient } from '@/lib/api/query';
import type { SessionView } from '@/lib/api/session';
import type { StaffRole } from '@/lib/api/generated';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import { BUNDLED, pickNamespaces } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { ConsoleShell } from './console-shell';
import { useShortcut } from './shortcuts';
import { useIntentHandler, useStepUp } from './step-up';

const goTo = vi.fn();
vi.mock('@/lib/browser', async (importOriginal) => ({ ...(await importOriginal<object>()), goTo: (url: string) => goTo(url) }));

const nav = vi.hoisted(() => ({ pathname: '/', search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}));

const MIN = 60_000;

function view(roles: StaffRole[], o: { leftMs?: number; intents?: SessionView['pending_intents']; absolute?: boolean } = {}): SessionView {
  const server = Date.parse('2026-11-09T10:00:00Z');
  const idle = new Date(server + (o.leftMs ?? 30 * MIN)).toISOString();
  return {
    signed_in: true,
    staff: {
      id: 'staff-1',
      display_name: 'Mina Moderator',
      roles,
      locale: 'en',
      timezone: 'Asia/Tehran',
      acr: 'aal3',
      auth_time: '2026-11-09T09:00:00Z',
    },
    locale: 'en',
    idle_expires_at: idle,
    expires_at: o.absolute ? idle : new Date(server + 8 * 60 * MIN).toISOString(),
    pending_intents: o.intents ?? [],
    server_time: new Date(server).toISOString(),
  };
}

let sessionAnswer: () => SessionView;
const posted: { url: string; body: unknown }[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/bff/session') return Response.json(sessionAnswer());
  if (url === '/bff/csrf') return Response.json({ csrf_token: 'csrf' });
  posted.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
  if (url === '/bff/logout') return Response.json({ ok: true });
  if (url === '/bff/intents') return Response.json({ intent_id: 'intent-1' }, { status: 201 });
  if (url === '/bff/intents/i1/consume')
    return Response.json({ id: 'i1', type: 'flag.update', target: 'ai.enabled', return_to: '/', draft: { enabled: false } });
  if (url.startsWith('/bff/intents/')) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
  return new Response('{}', { status: 404 });
});

const apiCalls: string[] = [];
function setup(initial: SessionView, children: ReactNode = <p>page</p>, locale: Locale = 'en') {
  sessionAnswer = () => initial;
  const api = createApiClient({
    transport: async (req) => {
      apiCalls.push(req.opId);
      return Response.json({ user_id: 'staff-1' });
    },
  });
  const queryClient = createQueryClient();
  return render(
    <I18nProvider locale={locale} resources={pickNamespaces(BUNDLED[locale])}>
      <FormatProvider timeZone="Asia/Tehran" distanceUnit="km">
        <ApiProvider client={api} queryClient={queryClient} initialSession={initial}>
          <ConsoleShell envBadge={<p data-testid="env-badge">DEV</p>} themeChoice="auto">
            {children}
          </ConsoleShell>
        </ApiProvider>
      </FormatProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  nav.pathname = '/';
  nav.search = '';
  goTo.mockReset();
  nav.replace.mockReset();
  posted.length = 0;
  apiCalls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const navLinks = () =>
  within(screen.getByRole('navigation', { name: 'Console sections' }))
    .getAllByRole('link')
    .map((a) => a.textContent);

describe('console shell navigation (GD-09)', () => {
  it('shows a moderator the moderation sections and no ADM-only settings', () => {
    setup(view(['MOD']));
    const links = navLinks();
    expect(links).toEqual(expect.arrayContaining(['Dashboard', 'Pending approvals', 'Reviews', 'Content', 'Disputes & appeals']));
    for (const adm of ['Feature flags', 'Exchange rates', 'Plans & entitlements', 'Audit log', 'Staff']) expect(links).not.toContain(adm);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('env-badge')).toBeInTheDocument();
  });

  it('shows a community reviewer three sections, and marks the current one', () => {
    nav.pathname = '/reviews';
    setup(view(['CRV']));
    expect(navLinks()).toEqual(['Dashboard', 'Reviews', 'Disputes & appeals']);
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute('aria-current', 'page');
  });

  it('the account menu shows the roles, the language and theme links and signs out', async () => {
    setup(view(['ADM', 'CRV']));
    fireEvent.click(screen.getByRole('button', { name: /Mina Moderator/ }));
    expect(screen.getByText('Roles: Platform admin · Community reviewer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My actions in the audit log' })).toHaveAttribute('href', '/audit?actor=me');
    expect(screen.getByRole('link', { name: 'فارسی' })).toHaveAttribute('href', '/?lang=fa');
    expect(screen.getByRole('link', { name: 'Night' })).toHaveAttribute('href', '/?theme=dark');
    // After the sign-out the session view says signed out: the watch must not take that for a session the server ended.
    sessionAnswer = () => ({ ...view(['ADM']), signed_in: false, staff: null, idle_expires_at: null, expires_at: null });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/signed-out?reason=logout'));
    await new Promise((r) => setTimeout(r, 50));
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(posted.map((p) => p.url)).toContain('/bff/logout');
  });

  it('hides "My actions" from roles that cannot read the audit log', () => {
    setup(view(['MOD']));
    fireEvent.click(screen.getByRole('button', { name: /Mina Moderator/ }));
    expect(screen.queryByRole('link', { name: 'My actions in the audit log' })).toBeNull();
  });

  it('shows a sign-in outcome that came back while still signed in, then drops it from the URL', async () => {
    nav.pathname = '/flags';
    nav.search = 'signin=account&tab=x';
    setup(view(['ADM']));
    expect(await screen.findByText('Confirm with the same staff account you are signed in with.')).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith('/flags?tab=x', { scroll: false });
  });

  it('renders in Persian', () => {
    setup(view(['SUP']), <p>page</p>, 'fa');
    expect(screen.getByRole('navigation', { name: 'بخش‌های کنسول' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'درخواست‌های حریم خصوصی' })).toBeInTheDocument();
  });
});

function Shortcuts({ onNext }: { onNext: () => void }) {
  useShortcut('next', onNext);
  return <input aria-label="note" />;
}

describe('keyboard shortcuts (AC4.T7)', () => {
  it('runs what the page registered, never while typing, and lists the keys with ?', () => {
    const onNext = vi.fn();
    setup(view(['MOD']), <Shortcuts onNext={onNext} />);
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(onNext).toHaveBeenCalledTimes(1);
    // A Persian layout sends another character for the same key.
    fireEvent.keyDown(document.body, { key: 'ت', code: 'KeyJ' });
    expect(onNext).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByLabelText('note'), { key: 'j', code: 'KeyJ' });
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ', ctrlKey: true });
    expect(onNext).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true });
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(help).getByText('Next item')).toBeInTheDocument();
    expect(within(help).getByText('Approve').closest('tr')).toHaveAttribute('data-available', 'false');
    expect(within(help).getByText('Next item').closest('tr')).toHaveAttribute('data-available', 'true');
    // While a dialog is open the page's keys stay off.
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it('/ goes to the lookup box', () => {
    setup(view(['MOD']));
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    expect(screen.getByRole('searchbox', { name: 'Look up' })).toHaveFocus();
  });
});

describe('idle handling (AC4.T4)', () => {
  it('warns in the last 5 minutes; "Stay signed in" calls the API and the new deadline closes the warning', async () => {
    const warning = view(['MOD'], { leftMs: 4 * MIN });
    setup(warning);
    const dialog = await screen.findByRole('alertdialog', { name: 'Still there?' });
    expect(within(dialog).getByTestId('idle-left')).toHaveTextContent(/signed out in 3:5\d|signed out in 4:00/);
    sessionAnswer = () => view(['MOD'], { leftMs: 30 * MIN });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The shell's My queue (AC5) reads the approvals count for a MOD too; "Stay signed in" adds exactly one staff_me.
    expect(apiCalls.filter((op) => op !== 'admin.four_eyes_list')).toEqual(['admin.staff_me']);
  });

  it('signs out at the end, clears the session and goes to the signed-out page with the return path', async () => {
    window.history.replaceState(null, '', '/flags?tab=all');
    setup(view(['ADM'], { leftMs: 0 }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/signed-out?reason=idle&return_to=%2Fflags%3Ftab%3Dall'));
    window.history.replaceState(null, '', '/');
    expect(posted.map((p) => p.url)).toContain('/bff/logout');
  });

  it('at the 8-hour end there is nothing to stay for', async () => {
    setup(view(['ADM'], { leftMs: 3 * MIN, absolute: true }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('button', { name: 'Stay signed in' })).toBeNull();
    expect(within(dialog).getByText(/Your 8-hour session ends in/)).toBeInTheDocument();
  });

  it('a session the BFF ended goes to the signed-out page', async () => {
    setup(view(['ADM']));
    act(() => {
      window.dispatchEvent(new Event('carpal-admin:session-ended'));
    });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(expect.stringMatching(/^\/id\/signed-out\?reason=ended/)));
  });
});

function Sensitive({ onReplay }: { onReplay: (draft: unknown) => void }) {
  const stepUp = useStepUp();
  useIntentHandler('flag.update', (intent) => onReplay(intent.draft));
  return (
    <button
      type="button"
      onClick={() =>
        void stepUp({
          type: 'flag.update',
          target: 'ai.enabled',
          draft: { enabled: false },
          run: async () => {
            throw new ApiProblem(
              401,
              { code: 'STEP_UP_REQUIRED' },
              { wwwAuthenticate: 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=300' },
            );
          },
        })
      }
    >
      turn off
    </button>
  );
}

describe('step-up (AC4.T5, GD-11)', () => {
  it('explains, saves the action server-side and re-authenticates with the security key', async () => {
    setup(view(['ADM']), <Sensitive onReplay={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'turn off' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm with security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/bff/reauth?return_to=%2F&intent=intent-1'));
    expect(posted.find((p) => p.url === '/bff/intents')?.body).toEqual({
      type: 'flag.update',
      target: 'ai.enabled',
      return_to: '/',
      draft: { enabled: false },
    });
  });

  it('replays the saved action once after the step-up', async () => {
    const onReplay = vi.fn();
    const intents = [{ id: 'i1', type: 'flag.update', target: 'ai.enabled', return_to: '/' }];
    sessionAnswer = () => view(['ADM'], { intents });
    setup(view(['ADM'], { intents }), <Sensitive onReplay={onReplay} />);
    await waitFor(() => expect(onReplay).toHaveBeenCalledWith({ enabled: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(posted.filter((p) => p.url === '/bff/intents/i1/consume')).toHaveLength(1);
  });
});
