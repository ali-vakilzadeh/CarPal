import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type TransportRequest } from './client';
import { ApiProvider, useApiInfiniteQuery, useApiQuery } from './query';
import { loginUrl, useSession } from './session';

const page = (items: string[], next: string | null) => Response.json({ items: items.map((id) => ({ id })), next_cursor: next });
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ status, code, title: code, type: 'x', request_id: 'r' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('query helpers', () => {
  it('useApiQuery renders data and typed errors', async () => {
    const client = createApiClient({
      transport: async (r) => (r.path === '/v1/me' ? Response.json({ display_name: 'Sara' }) : problem(404, 'NOT_FOUND')),
    });
    function Me() {
      const me = useApiQuery('me.get', undefined);
      const missing = useApiQuery('vehicles.get', { path: { vehicle_id: 'gone' } });
      return (
        <p>
          {me.data?.display_name ?? '…'} / {missing.error?.code ?? '…'}
        </p>
      );
    }
    render(
      <ApiProvider client={client}>
        <Me />
      </ApiProvider>,
    );
    expect(await screen.findByText('Sara / NOT_FOUND')).toBeInTheDocument();
  });

  it('a list whose cursor became invalid starts again from the first page (CURSOR_MISMATCH)', async () => {
    const sent: TransportRequest[] = [];
    let mismatch = true;
    const client = createApiClient({
      transport: async (r) => {
        sent.push(r);
        if (!r.search.includes('cursor')) return page(['a', 'b'], 'c2');
        if (mismatch) {
          mismatch = false;
          return problem(400, 'CURSOR_MISMATCH');
        }
        return page(['c'], null);
      },
    });
    let fetchNext: () => Promise<unknown> = async () => undefined;
    function List() {
      const q = useApiInfiniteQuery('vehicles.list', undefined);
      fetchNext = q.fetchNextPage;
      const ids = q.data?.pages.flatMap((p) => p.items.map((v) => v.id)) ?? [];
      return <p>{ids.join(',') || 'loading'}</p>;
    }
    render(
      <ApiProvider client={client}>
        <List />
      </ApiProvider>,
    );
    expect(await screen.findByText('a,b')).toBeInTheDocument();
    await act(async () => void (await fetchNext()));
    // Reset to page one instead of an error state; then paging works again.
    await waitFor(() => expect(sent.filter((r) => !r.search.includes('cursor'))).toHaveLength(2));
    expect(await screen.findByText('a,b')).toBeInTheDocument();
    await act(async () => void (await fetchNext()));
    expect(await screen.findByText('a,b,c')).toBeInTheDocument();
    expect(sent.find((r) => r.search.includes('cursor'))!.search).toBe('?cursor=c2');
  });

  it('useSession reads /bff/session; loginUrl carries the return path and step-up', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        signed_in: true,
        user: { id: 'u', display_name: 'Sara', acr: 'aal1', auth_time: 1 },
        locale: 'fa',
        pending_intents: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    function Who() {
      const s = useSession();
      return <p>{s.data ? (s.data.signed_in ? s.data.user?.display_name : 'guest') : '…'}</p>;
    }
    render(
      <ApiProvider client={createApiClient({ transport: async () => Response.json({}) })}>
        <Who />
      </ApiProvider>,
    );
    expect(await screen.findByText('Sara')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/bff/session', expect.objectContaining({ credentials: 'same-origin' }));
    expect(loginUrl({ returnTo: '/fa/garage?x=1', stepUp: 'aal2' })).toBe('/bff/login?return_to=%2Ffa%2Fgarage%3Fx%3D1&step_up=aal2');
  });
});
