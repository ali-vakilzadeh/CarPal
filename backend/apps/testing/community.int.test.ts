// S6 community (40 §19): follows and favourites, posts (draft, edit,
// publication rules, public list, follower notification), comments,
// reactions (one per user and type; the subject organization's members do
// not count, SEC-BF-9), showcases and Q&A (context rule, private vehicle
// link, business answers, accepted answer). The Should-have flags are
// switched on for this file only.
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, newId, outbox } from './s5-support.js';
import { flagsOn, flush, publishedProvider, type PublishedOrg } from './s6-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;
let symptom: string;
let provider: PublishedOrg;

beforeAll(async () => {
  app = await createTestApp({ host: 'api', providers: [flagsOn('community.feed.enabled', 'community.comments.enabled', 'qna.enabled')] });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
  symptom = await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
    const r = await db
      .selectFrom('taxonomy.taxonomy_nodes')
      .select('id')
      .where('type', '=', 'symptom')
      .where('status', '=', 'active')
      .orderBy('sort_order')
      .executeTakeFirstOrThrow();
    return r.id;
  });
  provider = await publishedProvider(app, n, { name: `Community Garage ${newId().slice(-6)}` });
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

async function newUser() {
  const user = await app.fixtures.user();
  const token = await app.fixtures.token(user);
  return { user, token, c: client(app, token) };
}

const tip = (o: Json = {}) => ({
  post_type: 'educational_tip',
  title: 'Check your brake fluid',
  body: 'Brake fluid absorbs water over time; change it every two years.',
  content_locale: 'en',
  comments_enabled: true,
  visibility: 'public',
  ...o,
});

describe('follows and favourites (40 §19.2)', () => {
  it('follows a published organization once, changes the setting, unfollows; favourites likewise', async () => {
    const u = await newUser();
    const put = await u.c.put(`/v1/me/follows/${provider.id}`, { notification_preference: 'all' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ organization: { id: provider.id, roles: ['provider'] }, notification_preference: 'all' });
    expect(
      (await u.c.put(`/v1/me/follows/${provider.id}`, { notification_preference: 'important_only' })).body.notification_preference,
    ).toBe('important_only');
    const list = await u.c.get('/v1/me/follows');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].notification_preference).toBe('important_only');
    // Unpublished or unknown organizations cannot be followed.
    const draft = await app.fixtures.org('provider');
    expect((await u.c.put(`/v1/me/follows/${draft.id}`, { notification_preference: 'all' })).status).toBe(404);
    expect((await u.c.del(`/v1/me/follows/${provider.id}`)).body).toEqual({ ok: true });
    expect((await u.c.get('/v1/me/follows')).body.items).toEqual([]);

    expect((await u.c.put(`/v1/me/favorites/${provider.id}`, undefined)).status).toBe(200);
    const again = await u.c.put(`/v1/me/favorites/${provider.id}`, undefined);
    expect(again.body).toMatchObject({ organization: { id: provider.id } });
    expect((await u.c.get('/v1/me/favorites')).body.items).toHaveLength(1);
    // Another user's list is their own (RLS self_all).
    expect((await (await newUser()).c.get('/v1/me/favorites')).body.items).toEqual([]);
    await u.c.del(`/v1/me/favorites/${provider.id}`);
    expect((await u.c.get('/v1/me/favorites')).body.items).toEqual([]);
  });
});

describe('posts (40 §19.2)', () => {
  it('drafts, edits, publishes and removes a post; text with contact data waits for moderation; followers are told', async () => {
    const follower = await newUser();
    await follower.c.put(`/v1/me/follows/${provider.id}`, { notification_preference: 'all' });
    const posts = `/v1/orgs/${provider.id}/posts`;
    expect((await provider.c.post(posts, tip({ post_type: 'showcase' }))).body.errors).toEqual([
      { pointer: '/portfolio_item_id', code: 'conditional_required' },
    ]);
    expect((await provider.c.post(posts, tip({ body: 'too short' }))).body.errors).toEqual([
      { pointer: '/body', code: 'too_short', limit: '10' },
    ]);
    const draft = await provider.c.post(posts, tip());
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'draft',
      moderation_status: 'approved',
      author_organization: { id: provider.id },
      like_count: 0,
    });
    const edited = await provider.c.patch(`${posts}/${draft.body.id}`, { title: 'Brake fluid every two years' }, draft.body.version);
    expect(edited.status).toBe(200);
    expect((await provider.c.patch(`${posts}/${draft.body.id}`, { title: 'Stale' }, draft.body.version)).status).toBe(412);
    const pub = await provider.c.post(`${posts}/${draft.body.id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: 'published', published_at: expect.any(String) });
    const anon = await app.fixtures.anonymousToken();
    const publicList = await app.request<Json>({ path: `/v1/public/orgs/${provider.id}/posts`, token: anon });
    expect(publicList.body.items.map((p: Json) => p.id)).toContain(draft.body.id);
    expect((await outbox(app, draft.body.id)).map((e) => e.type).sort()).toEqual(['community.content.changed', 'community.post.published']);

    await flush(app, worker);
    const notes = await follower.c.get('/v1/me/notifications');
    expect(notes.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'favorite_provider_update',
          category: 'community',
          template_key: 'community.followed_update',
          reference: { type: 'post', id: draft.body.id },
        }),
      ]),
    );

    const spam = await provider.c.post(posts, tip({ body: 'Call me on 0912 123 4567 for a cheap deal on parts!' }));
    expect(spam.body.moderation_status).toBe('pending');
    const blocked = await provider.c.post(`${posts}/${spam.body.id}/publish`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVALID_TRANSITION');

    expect((await provider.c.del(`${posts}/${draft.body.id}`)).body).toEqual({ ok: true });
    expect(
      (await app.request<Json>({ path: `/v1/public/orgs/${provider.id}/posts`, token: anon })).body.items.map((p: Json) => p.id),
    ).not.toContain(draft.body.id);
    // Record-level BOLA: another provider cannot touch this post under its own path.
    const other = await publishedProvider(app, n, { name: `Other Garage ${newId().slice(-6)}` });
    expect((await other.c.post(`/v1/orgs/${other.id}/posts/${spam.body.id}/publish`)).status).toBe(404);
  });
});

describe('comments and reactions (40 §19.2)', () => {
  it("comments where allowed, counts one reaction per user and type, and ignores the subject organization's members", async () => {
    const posts = `/v1/orgs/${provider.id}/posts`;
    const open = await provider.c.post(posts, tip());
    await provider.c.post(`${posts}/${open.body.id}/publish`);
    const closed = await provider.c.post(posts, tip({ comments_enabled: false }));
    await provider.c.post(`${posts}/${closed.body.id}/publish`);
    const u = await newUser();
    const comment = await u.c.post('/v1/comments', {
      target: { type: 'post', id: open.body.id },
      body: 'Thanks, very useful!',
      content_locale: 'en',
    });
    expect(comment.status).toBe(201);
    expect(comment.body).toMatchObject({ target: { type: 'post', id: open.body.id }, status: 'active', author: { avatar_url: null } });
    const disabled = await u.c.post('/v1/comments', { target: { type: 'post', id: closed.body.id }, body: 'Hello', content_locale: 'en' });
    expect(disabled.status).toBe(409);
    const anon = await app.fixtures.anonymousToken();
    const listed = await app.request<Json>({ path: `/v1/comments?target_type=post&target_id=${open.body.id}`, token: anon });
    expect(listed.body.items.map((c: Json) => c.id)).toEqual([comment.body.id]);
    expect((await (await newUser()).c.del(`/v1/comments/${comment.body.id}`)).status).toBe(404);

    const like = { target: { type: 'post', id: open.body.id }, reaction_type: 'like' };
    expect((await u.c.put('/v1/reactions', like)).body).toEqual({ count: 1 });
    expect((await u.c.put('/v1/reactions', like)).body).toEqual({ count: 1 });
    // The provider's own member does not count (SEC-BF-9).
    expect((await provider.c.put('/v1/reactions', like)).body).toEqual({ count: 1 });
    const second = await newUser();
    expect((await second.c.put('/v1/reactions', like)).body).toEqual({ count: 2 });
    expect((await u.c.post('/v1/reactions/remove', like)).body).toEqual({ count: 1 });
    expect((await u.c.put('/v1/reactions', { target: { type: 'comment', id: comment.body.id }, reaction_type: 'helpful' })).status).toBe(
      422,
    );
    const post = await provider.c.get(`${posts}?status=published`);
    expect(post.body.items.find((p: Json) => p.id === open.body.id).like_count).toBe(1);
    expect((await u.c.del(`/v1/comments/${comment.body.id}`)).body).toEqual({ ok: true });
  });
});

describe('questions and answers (40 §19.2)', () => {
  it('asks with context, answers as a business, accepts, closes; the private vehicle link never shows', async () => {
    const asker = await newUser();
    expect(
      (await asker.c.post('/v1/questions', { title: 'Strange noise', body: 'A noise when I brake hard.', content_locale: 'en' })).body
        .errors,
    ).toEqual([{ pointer: '/symptom_node_id', code: 'conditional_required' }]);
    const vehicleId = await app.fixtures.vehicle(asker.user, n);
    const q = await asker.c.post('/v1/questions', {
      vehicle_id: vehicleId,
      symptom_node_id: symptom,
      title: 'Grinding noise when braking',
      body: 'My car makes a grinding noise when I brake at low speed.',
      content_locale: 'en',
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({
      status: 'open',
      answer_count: 0,
      accepted_answer_id: null,
      vehicle: { brand: { text: expect.any(String) } },
    });
    expect(JSON.stringify(q.body)).not.toContain(vehicleId);
    const created = (await outbox(app, q.body.id)).find((e) => e.type === 'qna.question.created')!;
    expect(created.payload).toMatchObject({ question_id: q.body.id, symptom_node_id: symptom });
    expect(JSON.stringify(created.payload)).not.toContain(vehicleId);

    const anon = await app.fixtures.anonymousToken();
    const found = await app.request<Json>({
      method: 'POST',
      path: '/v1/questions/search',
      token: anon,
      body: { text: 'grinding brake', status: 'open' },
    });
    expect(found.body.items.map((x: Json) => x.id)).toContain(q.body.id);

    const answer = await provider.c.post(`/v1/questions/${q.body.id}/answers`, {
      body: 'Most likely worn pads; have them checked soon.',
      content_locale: 'en',
      as_organization_id: provider.id,
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ organization: { id: provider.id }, accepted: false });
    const stranger = await newUser();
    expect(
      (
        await stranger.c.post(`/v1/questions/${q.body.id}/answers`, {
          body: 'I am a business too, trust me.',
          content_locale: 'en',
          as_organization_id: provider.id,
        })
      ).status,
    ).toBe(404);
    expect((await stranger.c.post(`/v1/questions/${q.body.id}/accept`, { answer_id: answer.body.id })).status).toBe(404);
    const accepted = await asker.c.post(`/v1/questions/${q.body.id}/accept`, { answer_id: answer.body.id });
    expect(accepted.body).toMatchObject({ status: 'answered', accepted_answer_id: answer.body.id, answer_count: 1 });
    const full = await app.request<Json>({ path: `/v1/questions/${q.body.id}`, token: anon });
    expect(full.body.answers.items[0]).toMatchObject({ id: answer.body.id, accepted: true });
    expect((await provider.c.del(`/v1/answers/${answer.body.id}`)).status).toBe(409);

    const current = await asker.c.get(`/v1/questions/${q.body.id}`);
    const closed = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/questions/${q.body.id}`,
      token: asker.token,
      body: { status: 'closed' },
      headers: { 'if-match': current.headers.etag as string },
    });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(
      (await stranger.c.post(`/v1/questions/${q.body.id}/answers`, { body: 'Late answer to a closed question.', content_locale: 'en' }))
        .status,
    ).toBe(409);
  });

  it('showcases.get answers 404 for anything not published', async () => {
    const anon = await app.fixtures.anonymousToken();
    expect((await app.request<Json>({ path: `/v1/public/showcases/${newId()}`, token: anon })).status).toBe(404);
  });
});
