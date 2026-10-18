// Domain fixtures shared by the contract sweep resolvers: records several
// modules' operations need (published showcases and posts, symptoms, …),
// built through the API where the flow is short and in the system context
// where a step belongs to another actor (moderation approval).
import { sql } from 'kysely';
import { ok, type Harness, type Json, type Published } from './harness.js';

export const tip = (o: Json = {}) => ({
  post_type: 'educational_tip',
  title: 'Check your brake fluid',
  body: 'Brake fluid absorbs water over time; change it every two years.',
  content_locale: 'en',
  comments_enabled: true,
  visibility: 'public',
  ...o,
});

/** A published provider shared by a suite (read-only use: follows, posts, answers, public reads). */
export const sharedProvider = (h: Harness): Promise<Published> => h.once('shared:provider', () => h.provider());

/** A published post of a provider (draft → publish through the API). */
export async function publishedPost(h: Harness, p: Published, o: Json = {}): Promise<Json> {
  const posts = `/v1/orgs/${p.id}/posts`;
  const draft = ok(await p.as.c.post(posts, tip(o)), 'post');
  return ok(await p.as.c.post(`${posts}/${draft.id}/publish`), 'post publish');
}

/** A portfolio item with a processed photo, published (moderation approval applied in the system context). */
export async function showcase(h: Harness, p: Published): Promise<string> {
  const prv = `/v1/orgs/${p.id}/provider`;
  const item = ok(
    await p.as.c.post(`${prv}/portfolio`, {
      title: 'Control arm replacement',
      content_locale: 'en',
      brand_node_id: h.n.brand,
      model_node_id: h.n.model,
      service_system_node_id: h.n.system,
      caption: 'Old vs new arm',
      caption_source: 'manual',
      visibility: 'public',
    }),
    'portfolio item',
  );
  const asset = await h.upload(p.as, 'portfolio');
  ok(
    await p.as.c.post('/v1/media/attachments', {
      media_asset_id: asset.id,
      attached_to: { type: 'portfolio_item', id: item.id },
      role: 'gallery',
      display_order: 0,
    }),
    'portfolio attachment',
  );
  ok(await p.as.c.post(`${prv}/portfolio/${item.id}/publish`), 'portfolio publish');
  await h.q(
    sql`UPDATE organization.portfolio_items SET status = 'published', moderation_status = 'approved', published_at = now() WHERE id = ${item.id}::uuid`,
  );
  await h.q(sql`UPDATE media.media_assets SET moderation_status = 'approved' WHERE id = ${asset.id}::uuid`);
  return item.id as string;
}

/** An active symptom node. */
export async function symptomNode(h: Harness): Promise<string> {
  return h.once('symptom', async () => {
    const [row] = await h.q<{ id: string }>(
      sql`SELECT id FROM taxonomy.taxonomy_nodes WHERE type = 'symptom' AND status = 'active' ORDER BY sort_order, id LIMIT 1`,
    );
    return row!.id;
  });
}
