// AC3.T7 (GD-12): the TanStack Query cache is memory-only and is cleared on sign-out, when the BFF reports the
// session ended, and when another staff member signs in in the same tab.
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiProvider, createQueryClient, SESSION_ENDED_EVENT, useApiQuery, useLogout } from './query';
import { SESSION_QUERY_KEY } from './session';

const view = (id: string | null) => ({
  signed_in: !!id,
  staff: id
    ? { id, display_name: id, roles: ['ADM'], locale: 'en', timezone: 'Asia/Tehran', acr: 'aal3', auth_time: '2026-11-09T10:00:00Z' }
    : null,
  locale: 'en',
  idle_expires_at: null,
  expires_at: null,
  pending_intents: [],
  server_time: '2026-11-09T10:00:00Z',
});

let sessionId: string | null = 'staff-a';
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/bff/session') return Response.json(view(sessionId));
  if (url === '/bff/csrf') return Response.json({ csrf_token: 't' });
  if (url === '/bff/logout') return Response.json({ ok: true });
  return new Response('{}', { status: 404 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionId = 'staff-a';
});

function Flags() {
  const q = useApiQuery('admin.flags_list', undefined);
  const logout = useLogout();
  return (
    <div>
      <span>{q.data ? 'flags loaded' : 'no flags'}</span>
      <button onClick={() => void logout()}>sign out</button>
    </div>
  );
}

function setup(answer: () => Response) {
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const api = createApiClient({ transport: async () => answer() });
  render(
    <ApiProvider client={api} queryClient={queryClient}>
      <Flags />
    </ApiProvider>,
  );
  return { queryClient, api };
}

describe('ApiProvider cache (GD-12)', () => {
  it('sign-out clears every cached response and ETag', async () => {
    const { queryClient, api } = setup(() => Response.json({ items: [] }, { headers: { etag: '"v1"' } }));
    await screen.findByText('flags loaded');
    expect(api.etags.get('/v1/admin/flags')).toBe('"v1"');
    act(() => screen.getByText('sign out').click());
    await waitFor(() => expect(queryClient.getQueryData(['admin.flags_list', {}, {}, null, null])).toBeUndefined());
    expect(api.etags.get('/v1/admin/flags')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/bff/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('a staff switch in the same tab clears the cache but keeps the new session view', async () => {
    const { queryClient } = setup(() => Response.json({ items: [] }));
    await screen.findByText('flags loaded');
    await waitFor(() => expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({ staff: { id: 'staff-a' } }));
    sessionId = 'staff-b';
    await act(() => queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }));
    await waitFor(() => expect(queryClient.getQueryData(['admin.flags_list', {}, {}, null, null])).toBeUndefined());
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({ staff: { id: 'staff-b' } });
  });

  it('the default browser client clears the cache and tells the shell when the BFF says the session ended', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/bff/session') return Response.json(view('staff-a'));
        return new Response(JSON.stringify({ code: 'SESSION_ENDED', status: 401 }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        });
      }),
    );
    const queryClient = createQueryClient();
    queryClient.setQueryData(['admin.plans_list', {}, {}, null, null], { items: ['secret'] });
    const ended = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    render(
      <ApiProvider queryClient={queryClient}>
        <Flags />
      </ApiProvider>,
    );
    await waitFor(() => expect(ended).toHaveBeenCalled());
    expect(queryClient.getQueryData(['admin.plans_list', {}, {}, null, null])).toBeUndefined();
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
  });
});
