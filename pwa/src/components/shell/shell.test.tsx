// P3.T4-T6/T9 component tests of the shell and the global patterns, inside the real client providers.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guest, renderApp, signedIn } from '../../../tests/support/render-app';
import { navigation, router } from '../../../tests/support/next-navigation';
import { ApiProblem } from '@/lib/api/problem';
import { SESSION_ENDED_EVENT } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { goTo } from '@/lib/browser-nav';
import { useGatedAction, useIntentHandler } from './auth-intent';
import { ErrorBoundary } from './error-boundary';
import { HoverCard, HOVER_DELAY_MS } from './hover-card';
import { InfiniteList } from './infinite-list';
import { PENDING_SEARCH_KEY } from './search-box';
import { SessionGate } from './session-gate';
import { ShellFrame } from './shell-frame';
import { StateView, stateFromProblem } from './states';
import { TOAST_MS, useToast } from './toast';
import { UrlModal, useUrlModal } from './url-modal';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let fetchHandler: FetchHandler;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  navigation.reset('/fa');
  window.history.replaceState(null, '', '/fa');
  document.cookie = 'cp_consent=; Max-Age=0; Path=/';
  sessionStorage.clear();
  fetchHandler = (url) => (url === '/bff/csrf' ? json({ csrf_token: 'csrf-1' }) : json({}, 404));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(fetchHandler(String(input), init))),
  );
  vi.mocked(goTo).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('header and navigation', () => {
  it('guest: log in / sign up back to this page, language switch keeps the page, no bell', () => {
    navigation.reset('/fa/questions?sort=new');
    renderApp(<ShellFrame>page</ShellFrame>);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'ورود' })).toHaveAttribute(
      'href',
      // Every sign-in comes back through the onboarding check (P4.T7).
      '/bff/login?return_to=%2Ffa%2Fonboarding%3Fnext%3D%252Ffa%252Fquestions%253Fsort%253Dnew&locale=fa',
    );
    expect(within(header).getByRole('link', { name: 'ثبت‌نام' }).getAttribute('href')).toContain('screen=signup');
    expect(within(header).getByRole('link', { name: 'English' })).toHaveAttribute('href', '/en/questions?sort=new');
    expect(within(header).getByRole('button', { name: 'باز کردن منو' })).toBeInTheDocument();
    expect(within(header).queryByRole('link', { name: /اعلان‌ها/ })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'اصلی' })).toBeNull();
    expect(screen.getByRole('main')).toHaveTextContent('page');
  });

  it('signed in: bell with the unread count, avatar menu, left navigation and tab bar', async () => {
    navigation.reset('/fa/garage');
    renderApp(<ShellFrame>page</ShellFrame>, {
      session: signedIn('سارا م.'),
      handlers: { 'notifications.unread_count': () => ({ count: 4 }), 'vehicles.list': () => ({ items: [], next_cursor: null }) },
    });
    expect(await screen.findByRole('link', { name: 'اعلان‌ها، ۴ خوانده‌نشده' })).toHaveAttribute('href', '/fa/notifications');
    const navs = screen.getAllByRole('navigation', { name: 'اصلی' });
    expect(navs).toHaveLength(2); // left navigation + bottom tab bar (CSS shows one per breakpoint)
    for (const nav of navs) expect(within(nav).getByRole('link', { name: /گاراژ من/ })).toHaveAttribute('aria-current', 'page');

    const avatar = screen.getByRole('button', { name: 'منوی حساب' });
    expect(avatar).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(avatar);
    expect(avatar).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('navigation', { name: 'منوی حساب' });
    expect(within(menu).getByRole('link', { name: 'تنظیمات' })).toHaveAttribute('href', '/fa/settings');
    expect(within(menu).getByRole('button', { name: 'خروج' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(avatar).toHaveAttribute('aria-expanded', 'false');
    expect(avatar).toHaveFocus();
  });

  it('caps the unread badge at 99+', async () => {
    renderApp(<ShellFrame>x</ShellFrame>, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'notifications.unread_count': () => ({ count: 120 }), 'vehicles.list': () => ({ items: [], next_cursor: null }) },
    });
    const bell = await screen.findByRole('link', { name: 'Notifications, 120 unread' });
    expect(bell).toHaveTextContent('99+');
  });
});

describe('search box', () => {
  it("'/' focuses the search unless the user is typing", () => {
    renderApp(
      <ShellFrame>
        <input aria-label="other" />
      </ShellFrame>,
    );
    const search = screen.getByRole('combobox', { name: 'جستجو در کارپال' });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(search).toHaveFocus();
    const other = screen.getByLabelText('other');
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(other).toHaveFocus();
  });

  it('suggests from taxonomy.suggest, navigates by keyboard and hands the query to the search page', async () => {
    const suggest = vi.fn(() => ({
      items: [
        {
          node: {
            id: 'n1',
            type: 'symptom',
            parent_id: null,
            name: { text: 'صدای ترمز', locale: 'fa' },
            description: null,
            slug: 'brake-noise',
            regions: [],
            attributes: null,
            sort_order: 0,
            status: 'active',
            merged_into_id: null,
          },
          matched_term: 'tormoz',
          match_kind: 'transliteration',
        },
      ],
    }));
    renderApp(<ShellFrame>x</ShellFrame>, { handlers: { 'taxonomy.suggest': suggest } });
    const search = screen.getByRole('combobox');
    fireEvent.focus(search);
    expect(screen.getByRole('link', { name: 'مرور روی نقشه' })).toHaveAttribute('href', '/fa/map');
    fireEvent.change(search, { target: { value: 'tormoz' } });
    expect(await screen.findByRole('option', { name: 'صدای ترمز' })).toBeInTheDocument();
    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ text: 'tormoz', types: expect.arrayContaining(['symptom']) }) }),
    );
    expect(search).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'صدای ترمز' }).id);
    fireEvent.submit(search.closest('form')!);
    expect(router.push).toHaveBeenCalledWith('/fa/search');
    expect(JSON.parse(sessionStorage.getItem(PENDING_SEARCH_KEY)!)).toMatchObject({
      text: 'صدای ترمز',
      node: { id: 'n1', type: 'symptom' },
    });
  });

  it('stops suggesting after a rate limit', async () => {
    const suggest = vi.fn(() => {
      throw new ApiProblem(429, { code: 'RATE_LIMITED' }, { retryAfterMs: 60_000 });
    });
    renderApp(<ShellFrame>x</ShellFrame>, { handlers: { 'taxonomy.suggest': suggest } });
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'lent' } });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    fireEvent.change(search, { target: { value: 'lent t' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('option', { name: 'جستجوی «lent t»' })).toBeInTheDocument();
  });
});

function ToastDemo({ undo }: { undo: () => void }) {
  const toast = useToast();
  return <button onClick={() => toast('Unfollowed', { undo })}>go</button>;
}

describe('toast with Undo', () => {
  it('shows bottom-start, runs Undo once, disappears after 5 s', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    renderApp(<ToastDemo undo={undo} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByRole('status')).toHaveTextContent('Unfollowed');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Unfollowed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.queryByText('Unfollowed')).toBeNull();
  });
});

function ModalDemo() {
  const modal = useUrlModal('report', ['target']);
  return (
    <>
      <button onClick={() => modal.open({ target: 'p1' })}>open</button>
      <UrlModal control={modal} name="report" title="Report">
        <p>body {modal.params.get('target')}</p>
      </UrlModal>
    </>
  );
}

describe('modal with a URL', () => {
  it('opens by pushing ?modal=, closes with Back; a refreshed URL opens it and closes by replace', () => {
    navigation.reset('/en/post/1');
    const { unmount } = renderApp(<ModalDemo />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(router.push).toHaveBeenCalledWith('/en/post/1?modal=report&target=p1', { scroll: false });
    expect(screen.getByRole('dialog', { name: 'Report' })).toHaveTextContent('body p1');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(router.back).toHaveBeenCalled();
    expect(screen.queryByText('body p1')).toBeNull();
    unmount();

    navigation.reset('/en/post/1?modal=report&target=p2');
    renderApp(<ModalDemo />, { locale: 'en' });
    expect(screen.getByRole('dialog', { name: 'Report' })).toHaveTextContent('body p2');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(router.replace).toHaveBeenCalledWith('/en/post/1', { scroll: false });
  });
});

function FollowDemo({ onRun, onReplay }: { onRun: () => void; onReplay: (target: string | null) => string }) {
  const gate = useGatedAction();
  useIntentHandler('follow', (intent) => onReplay(intent.target));
  return <button onClick={() => gate({ type: 'follow', target: 'shop-1', title: 'Sign in to follow Reza', run: onRun })}>Follow</button>;
}

describe('auth intent (GD-06)', () => {
  it('signed in: the action runs at once', () => {
    const onRun = vi.fn();
    renderApp(<FollowDemo onRun={onRun} onReplay={() => ''} />, { session: signedIn() });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(onRun).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('guest: context modal → intent saved in the pre-session → hosted sign-in with this page as return URL', async () => {
    window.history.replaceState(null, '', '/en/shop/reza');
    const posts: { url: string; body: unknown; csrf: string | null }[] = [];
    fetchHandler = (url, init) => {
      if (url === '/bff/csrf') return json({ csrf_token: 'csrf-1' });
      if (url === '/bff/intents') {
        posts.push({ url, body: JSON.parse(String(init?.body)), csrf: new Headers(init?.headers).get('x-csrf-token') });
        return json({ intent_id: 'i1' }, 201);
      }
      return json({}, 404);
    };
    const onRun = vi.fn();
    renderApp(<FollowDemo onRun={onRun} onReplay={() => ''} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in to follow Reza' });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log in' }));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('/bff/login?return_to=%2Fen%2Fonboarding%3Fnext%3D%252Fen%252Fshop%252Freza&locale=en&intent=i1'),
    );
    expect(posts).toEqual([
      {
        url: '/bff/intents',
        body: { type: 'follow', target: 'shop-1', return_to: '/en/shop/reza', label: 'Sign in to follow Reza' },
        csrf: 'csrf-1',
      },
    ]);
  });

  it('after sign-in: the intent for this page is consumed once and replayed with its toast', async () => {
    window.history.replaceState(null, '', '/en/shop/reza');
    const consumed: string[] = [];
    fetchHandler = (url) => {
      if (url === '/bff/csrf') return json({ csrf_token: 'csrf-1' });
      if (url === '/bff/intents/i1/consume') {
        consumed.push(url);
        return json({ id: 'i1', type: 'follow', target: 'shop-1', return_to: '/en/shop/reza', draft: null });
      }
      if (url === '/bff/session') return json(signedIn());
      return json({}, 404);
    };
    const onReplay = vi.fn(() => 'You are following Reza');
    renderApp(<FollowDemo onRun={vi.fn()} onReplay={onReplay} />, {
      locale: 'en',
      session: signedIn('Sara', [
        { id: 'i1', type: 'follow', target: 'shop-1', return_to: '/en/shop/reza' },
        { id: 'i2', type: 'follow', target: 'shop-2', return_to: '/en/other-page' },
      ]),
    });
    expect(await screen.findByText('You are following Reza')).toBeInTheDocument();
    expect(onReplay).toHaveBeenCalledOnce();
    expect(onReplay).toHaveBeenCalledWith('shop-1');
    expect(consumed).toEqual(['/bff/intents/i1/consume']);
  });
});

describe('sign-in notices (P4)', () => {
  it('SESSION_ENDED from the BFF and a sign-in that came back without success show a message', async () => {
    window.history.replaceState(null, '', '/en/garage?signin=cancelled');
    renderApp(<p>page</p>, { locale: 'en' });
    expect(await screen.findByText('Sign-in was cancelled.')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    });
    expect(await screen.findByText('You were signed out. Log in again to continue.')).toBeInTheDocument();
  });

  it('Switch account asks for credentials again (prompt=login)', () => {
    navigation.reset('/fa/garage?signin=failed');
    renderApp(<ShellFrame>page</ShellFrame>, { session: signedIn() });
    fireEvent.click(screen.getByRole('button', { name: 'منوی حساب' }));
    const href = screen.getByRole('link', { name: 'تغییر حساب' }).getAttribute('href')!;
    const q = new URL(href, 'http://x').searchParams;
    expect(q.get('prompt')).toBe('login');
    // An earlier outcome is not carried back.
    expect(q.get('return_to')).toBe('/fa/onboarding?next=%2Ffa%2Fgarage');
  });
});

describe('session gate', () => {
  it('signed in → the page; guest → hosted sign-in; back from a failed sign-in → the log-in state', async () => {
    navigation.reset('/fa/garage');
    const a = renderApp(<SessionGate>private</SessionGate>, { session: signedIn() });
    expect(screen.getByText('private')).toBeInTheDocument();
    a.unmount();

    renderApp(<SessionGate>private</SessionGate>, { session: guest }).unmount();
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/bff/login?return_to=%2Ffa%2Fonboarding%3Fnext%3D%252Ffa%252Fgarage&locale=fa'));

    vi.mocked(goTo).mockClear();
    navigation.reset('/fa/garage?signin=cancelled');
    renderApp(<SessionGate>private</SessionGate>, { session: guest });
    expect(screen.getByRole('heading', { name: 'برای دیدن این صفحه وارد شوید' })).toBeInTheDocument();
    expect(goTo).not.toHaveBeenCalled();
  });
});

describe('cookie consent', () => {
  it('first visit: three choices with equal prominence; the choice is stored and the banner closes', () => {
    renderApp(<ShellFrame>x</ShellFrame>, { locale: 'en', consent: null });
    const banner = screen.getByRole('region', { name: 'Cookies and privacy' });
    const buttons = within(banner).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Accept all', 'Reject non-essential', 'Choose']);
    expect(new Set(buttons.map((b) => b.className)).size).toBe(1);
    fireEvent.click(within(banner).getByRole('button', { name: 'Choose' }));
    expect(within(banner).getByLabelText('Usage statistics')).not.toBeChecked();
    expect(within(banner).getByLabelText('Essential')).toBeDisabled();
    fireEvent.click(within(banner).getByLabelText('Usage statistics'));
    fireEvent.click(within(banner).getByRole('button', { name: 'Save choices' }));
    expect(document.cookie).toContain('cp_consent=v1.a1');
    expect(screen.queryByRole('region', { name: 'Cookies and privacy' })).toBeNull();
  });

  it('no banner once decided; the footer reopens the choices as a URL modal', () => {
    renderApp(<ShellFrame>x</ShellFrame>, { locale: 'en', consent: { analytics: false } });
    expect(screen.queryByRole('region', { name: 'Cookies and privacy' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(router.push).toHaveBeenCalledWith('/fa?modal=cookies', { scroll: false });
    expect(screen.getByRole('dialog', { name: 'Cookies and privacy' })).toBeInTheDocument();
  });
});

describe('theme picker', () => {
  it('applies the choice at once and stores it', () => {
    renderApp(<ShellFrame>x</ShellFrame>, { locale: 'en' });
    const footer = screen.getByRole('contentinfo');
    const night = within(footer).getByRole('link', { name: 'Night' });
    expect(night).toHaveAttribute('href', '/fa?theme=dark');
    fireEvent.click(night);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-theme-choice', 'dark');
    expect(document.cookie).toContain('cp_theme=dark');
    expect(within(footer).getByRole('link', { name: 'Night' })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(within(footer).getByRole('link', { name: 'Automatic' }));
    expect(document.documentElement).toHaveAttribute('data-theme-choice', 'auto');
    expect(document.cookie).not.toContain('cp_theme=dark');
  });
});

describe('states (GD-13)', () => {
  it('maps API problems to states', () => {
    expect(stateFromProblem(new ApiProblem(503, { code: 'AI_UNAVAILABLE' }))).toBe('aiOff');
    expect(stateFromProblem(new ApiProblem(501, {}))).toBe('notAvailable');
    expect(stateFromProblem(new ApiProblem(403, { code: 'FEATURE_DISABLED' }))).toBe('featureOff');
    expect(stateFromProblem(new ApiProblem(404, { code: 'NOT_FOUND' }))).toBe('notFound');
    expect(stateFromProblem(new ApiProblem(410, { code: 'LINK_EXPIRED' }))).toBe('removed');
    expect(stateFromProblem(new ApiProblem(0, {}))).toBe('offline');
    expect(stateFromProblem(new ApiProblem(429, { code: 'RATE_LIMITED' }))).toBe('rateLimited');
    expect(stateFromProblem(new ApiProblem(500, { code: 'INTERNAL' }))).toBe('error');
    expect(stateFromProblem(new Error('x'))).toBe('error');
  });

  function States() {
    const t = useT();
    return <StateView kind="aiOff" t={t} />;
  }

  it('renders the AI-off state in the UI language', () => {
    renderApp(<States />);
    expect(screen.getByRole('heading', { name: 'کمک هوش مصنوعی فعلاً خاموش است' })).toBeInTheDocument();
  });

  it('the error boundary shows the state with a Retry that re-renders', () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new ApiProblem(0, {});
      return <p>recovered</p>;
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderApp(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
      { locale: 'en' },
    );
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    err.mockRestore();
  });
});

describe('hover card and infinite list', () => {
  it('hover card opens after 500 ms of mouse hover, never for touch', () => {
    vi.useFakeTimers();
    renderApp(
      <HoverCard label="Reza Auto" card={<span>card body</span>}>
        <a href="#shop">Reza Auto</a>
      </HoverCard>,
    );
    const trigger = screen.getByText('Reza Auto').parentElement!;
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS + 10));
    expect(screen.queryByText('card body')).toBeNull();
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS - 50));
    expect(screen.queryByText('card body')).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('group', { name: 'Reza Auto' })).toHaveTextContent('card body');
  });

  it('infinite list: skeleton, empty state, items with "Show more"', () => {
    const more = vi.fn();
    const base = {
      getKey: (i: number) => String(i),
      renderItem: (i: number) => <span>item {i}</span>,
      isFetchingNextPage: false,
      fetchNextPage: more,
      refetch: vi.fn(),
      empty: <p>none</p>,
      label: 'Posts',
      restoreKey: 't',
    };
    const a = renderApp(<InfiniteList {...base} items={[]} status="pending" hasNextPage={false} />, { locale: 'en' });
    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status');
    a.unmount();
    const b = renderApp(<InfiniteList {...base} items={[]} status="success" hasNextPage={false} />, { locale: 'en' });
    expect(screen.getByText('none')).toBeInTheDocument();
    b.unmount();
    renderApp(<InfiniteList {...base} items={[1, 2]} status="success" hasNextPage />, { locale: 'en' });
    expect(within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(more).toHaveBeenCalled();
  });
});
