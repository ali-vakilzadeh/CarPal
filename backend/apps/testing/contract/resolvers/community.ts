// Contract sweep resolvers: community — follows, favourites, posts, comments,
// reactions, showcases, Q&A (40 §19). The Should-have flags are on in the sweep.
import { expect } from 'vitest';
import { publishedPost, sharedProvider, showcase, symptomNode, tip } from '../domain.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

async function question(h: Harness): Promise<{ asker: Actor; q: Json; vehicleId: string }> {
  const asker = await h.user();
  const vehicleId = await h.vehicle(asker);
  const q = ok(
    await asker.c.post('/v1/questions', {
      vehicle_id: vehicleId,
      symptom_node_id: await symptomNode(h),
      title: 'Grinding noise when braking',
      body: 'My car makes a grinding noise when I brake at low speed.',
      content_locale: 'en',
    }),
    'question',
  );
  return { asker, q, vehicleId };
}

async function answer(h: Harness, questionId: string): Promise<{ by: Actor; a: Json }> {
  const by = await h.user();
  const a = ok(
    await by.c.post(`/v1/questions/${questionId}/answers`, {
      body: 'Most likely worn pads; have them checked soon.',
      content_locale: 'en',
    }),
    'answer',
  );
  return { by, a };
}

const like = (postId: string) => ({ target: { type: 'post', id: postId }, reaction_type: 'like' });

export const resolvers: Resolvers = {
  'follows.list': async (h) => {
    const as = await h.user();
    const p = await sharedProvider(h);
    ok(await as.c.put(`/v1/me/follows/${p.id}`, { notification_preference: 'all' }), 'follow');
    return { as, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'follows.put': async (h) => ({
    as: await h.user(),
    params: { org_id: (await sharedProvider(h)).id },
    body: { notification_preference: 'important_only' },
  }),
  'follows.delete': async (h) => {
    const as = await h.user();
    const p = await sharedProvider(h);
    ok(await as.c.put(`/v1/me/follows/${p.id}`, { notification_preference: 'all' }), 'follow');
    return { as, params: { org_id: p.id } };
  },
  'favorites.list': async (h) => {
    const as = await h.user();
    ok(await as.c.put(`/v1/me/favorites/${(await sharedProvider(h)).id}`, undefined), 'favorite');
    return { as, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'favorites.put': async (h) => ({ as: await h.user(), params: { org_id: (await sharedProvider(h)).id } }),
  'favorites.delete': async (h) => {
    const as = await h.user();
    const p = await sharedProvider(h);
    ok(await as.c.put(`/v1/me/favorites/${p.id}`, undefined), 'favorite');
    return { as, params: { org_id: p.id } };
  },
  'showcases.get': async (h) => ({ as: await h.anonymous(), params: { item_id: await showcase(h, await sharedProvider(h)) } }),
  'posts.org_list': async (h) => {
    const p = await sharedProvider(h);
    return { as: p.as, query: { status: 'published' } };
  },
  'posts.create': async (h) => ({ as: (await sharedProvider(h)).as, body: tip() }),
  'posts.update': async (h) => {
    const p = await sharedProvider(h);
    const draft = ok(await p.as.c.post(`/v1/orgs/${p.id}/posts`, tip()), 'post');
    return {
      as: p.as,
      params: { post_id: draft.id as string },
      version: draft.version as number,
      body: { title: 'Brake fluid every two years' },
    };
  },
  'posts.publish': async (h) => {
    const p = await sharedProvider(h);
    const draft = ok(await p.as.c.post(`/v1/orgs/${p.id}/posts`, tip()), 'post');
    return { as: p.as, params: { post_id: draft.id as string } };
  },
  'posts.delete': async (h) => {
    const p = await sharedProvider(h);
    const post = await publishedPost(h, p);
    return { as: p.as, params: { post_id: post.id as string } };
  },
  'posts.public_list': async (h) => {
    const p = await sharedProvider(h);
    await publishedPost(h, p);
    return { as: await h.anonymous(), params: { org_id: p.id }, check: (res) => expect(res.body.items.length).toBeGreaterThan(0) };
  },
  'comments.list': async (h) => {
    const p = await sharedProvider(h);
    const post = await publishedPost(h, p);
    const u = await h.user();
    ok(
      await u.c.post('/v1/comments', { target: { type: 'post', id: post.id }, body: 'Thanks, very useful!', content_locale: 'en' }),
      'comment',
    );
    return { as: await h.anonymous(), query: { target_type: 'post', target_id: post.id as string } };
  },
  'comments.create': async (h) => {
    const post = await publishedPost(h, await sharedProvider(h));
    return { as: await h.user(), body: { target: { type: 'post', id: post.id }, body: 'Thanks, very useful!', content_locale: 'en' } };
  },
  'comments.delete': async (h) => {
    const post = await publishedPost(h, await sharedProvider(h));
    const as = await h.user();
    const c = ok(
      await as.c.post('/v1/comments', { target: { type: 'post', id: post.id }, body: 'Thanks a lot!', content_locale: 'en' }),
      'comment',
    );
    return { as, params: { comment_id: c.id as string } };
  },
  'reactions.put': async (h) => {
    const post = await publishedPost(h, await sharedProvider(h));
    return { as: await h.user(), body: like(post.id as string), check: (res) => expect(res.body).toEqual({ count: 1 }) };
  },
  'reactions.delete': async (h) => {
    const post = await publishedPost(h, await sharedProvider(h));
    const as = await h.user();
    ok(await as.c.put('/v1/reactions', like(post.id as string)), 'reaction');
    return { as, body: like(post.id as string), check: (res) => expect(res.body).toEqual({ count: 0 }) };
  },
  'questions.create': async (h) => {
    const as = await h.user();
    return {
      as,
      body: {
        vehicle_id: await h.vehicle(as),
        symptom_node_id: await symptomNode(h),
        title: 'Grinding noise when braking',
        body: 'My car makes a grinding noise when I brake at low speed.',
        content_locale: 'en',
      },
      bodyRefs: true,
      check: (res) => expect(JSON.stringify(res.body)).not.toContain('vehicle_id'),
    };
  },
  'questions.search': async (h) => {
    await question(h);
    return { as: await h.anonymous(), body: { text: 'grinding brake', status: 'open' } };
  },
  'questions.get': async (h) => {
    const { q, vehicleId } = await question(h);
    return { as: await h.anonymous(), params: { question_id: q.id as string }, check: (res) => expect(res.text).not.toContain(vehicleId) };
  },
  'questions.update': async (h) => {
    const { asker, q } = await question(h);
    const current = await asker.c.get(`/v1/questions/${q.id}`);
    return {
      as: asker,
      params: { question_id: q.id as string },
      headers: { 'if-match': current.headers.etag! },
      body: { status: 'closed' },
    };
  },
  'answers.create': async (h) => {
    const { q } = await question(h);
    const p = await sharedProvider(h);
    return {
      as: p.as,
      params: { question_id: q.id as string },
      body: { body: 'Most likely worn pads; have them checked soon.', content_locale: 'en', as_organization_id: p.id },
      // SEC-AZ-4: answering as an organization the caller is not a member of.
      bola: { attackers: [await h.stranger()] },
    };
  },
  'answers.accept': async (h) => {
    const { asker, q } = await question(h);
    const { a } = await answer(h, q.id as string);
    return { as: asker, params: { question_id: q.id as string }, body: { answer_id: a.id } };
  },
  'answers.delete': async (h) => {
    const { q } = await question(h);
    const { by, a } = await answer(h, q.id as string);
    return { as: by, params: { answer_id: a.id as string } };
  },
};
