// Contract sweep resolvers: discovery — search, map, safety check, Discover feed (40 §14.2).
// Search sessions belong to their requester, anonymous callers included (RLS
// requester_all): another caller gets 404 for a session id it did not create.
import { expect } from 'vitest';
import { near, uniquePoint } from '../../s6-support.js';
import { area, ok, type Caller, type Harness, type Json, type Resolvers } from '../harness.js';

/** Two published, indexed providers close to one point (shared by the suite). */
function cluster(h: Harness): Promise<{ lat: number; lng: number }> {
  return h.once('discovery:cluster', async () => {
    const point = uniquePoint();
    await h.provider({ point });
    await h.provider({ point: near(point, 0.002, 0) });
    await h.settle();
    return point;
  });
}

/** A search session of a new anonymous caller with one result per page (a next cursor). */
async function session(h: Harness): Promise<{ as: Caller & { token: string }; body: Json }> {
  const point = await cluster(h);
  const as = (await h.anonymous()) as Caller & { token: string };
  const res = await h.api.request<Json>({
    method: 'POST',
    path: '/v1/search',
    token: as.token,
    body: { search_mode: 'all', entry_point: 'search_box', location: area(point), limit: 1, sort: 'distance' },
  });
  const body = ok(res, 'search.run');
  if (!body.next_cursor) throw new Error(`search.run: no next cursor (${res.text.slice(0, 200)})`);
  return { as, body };
}

const otherCaller = async (h: Harness) => ({ attackers: [await h.anonymous()] });

export const resolvers: Resolvers = {
  'search.run': async (h) => ({
    as: await h.anonymous(),
    body: { search_mode: 'all', entry_point: 'search_box', location: area(await cluster(h)) },
    check: (res) => expect(res.body.results.length).toBeGreaterThan(0),
  }),
  'search.page': async (h) => {
    const s = await session(h);
    return {
      as: s.as,
      params: { session_id: s.body.session_id as string },
      query: { cursor: s.body.next_cursor as string },
      // The cursor (required) is signed for its caller and session: another caller is refused before the session is read.
      // The same cursor for a session that does not exist is refused alike (the session is never read).
      bola: { ...(await otherCaller(h)), expect: [400], code: 'CURSOR_MISMATCH', absent: { params: { session_id: h.newId() } } },
      check: async () => {
        const res = await h.apiKill.request<Json>({
          path: `/v1/search/${s.body.session_id}/results?cursor=${encodeURIComponent(s.body.next_cursor)}`,
          token: ((await h.anonymous()) as { token: string }).token,
        });
        expect(res.body.code).toBe('CURSOR_MISMATCH');
      },
    };
  },
  'search.session_get': async (h) => {
    const s = await session(h);
    return {
      as: s.as,
      params: { session_id: s.body.session_id as string },
      // Sessions belong to their requester (RLS requester_all): another caller's read is 404 like an unknown id.
      bola: { ...(await otherCaller(h)), absent: { params: { session_id: h.newId() } } },
      check: (res) => expect(res.body.session_id).toBe(s.body.session_id),
    };
  },
  'search.refine': async (h) => {
    const s = await session(h);
    return { as: s.as, params: { session_id: s.body.session_id as string }, body: { sort: 'rating' }, bola: await otherCaller(h) };
  },
  'search.result_event': async (h) => {
    const s = await session(h);
    return {
      as: s.as,
      params: { session_id: s.body.session_id as string, result_id: s.body.results[0].result_id as string },
      body: { event: 'selected' },
      bola: await otherCaller(h),
    };
  },
  'map.pins': async (h) => ({
    as: await h.anonymous(),
    body: { viewport: area(await cluster(h), 0.02).viewport, layers: ['providers', 'vendors'] },
  }),
  'safety.check': async (h) => ({ as: await h.anonymous(), body: { text: 'oil change please', locale: 'en' } }),
  'feed.discover': async (h) => ({ as: await h.anonymous(), body: { location: area(await cluster(h), 0.02) } }),
};
