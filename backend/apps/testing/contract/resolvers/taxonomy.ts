// Contract sweep resolvers: taxonomy (40 §11) and its administration (40 §23.3).
import { sql } from 'kysely';
import { REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Resolvers } from '../harness.js';

const admin = (h: Harness) => h.staff('platform_admin');

/** A service_system node created through the admin API, removed again when the suite ends (seeded counts stay intact). */
async function tempNode(h: Harness, a: Actor): Promise<{ id: string; version: number }> {
  const slug = `sweep-system-${h.newId().slice(-10)}`;
  const node = ok(
    await a.c.post('/v1/admin/taxonomy/nodes', {
      type: 'service_system',
      name_translations: { en: 'Sweep system', fa: 'سامانه آزمون' },
      slug,
      reason: REASON,
    }),
    'taxonomy node',
  );
  removeNodeAtClose(h, node.id as string);
  return { id: node.id as string, version: node.version as number };
}

function removeNodeAtClose(h: Harness, id: string): void {
  h.onClose(() =>
    h.sys(async (db) => {
      await db
        .deleteFrom('taxonomy.taxonomy_mappings')
        .where((eb) => eb.or([eb('source_node_id', '=', id), eb('target_node_id', '=', id)]))
        .execute();
      await db.deleteFrom('taxonomy.taxonomy_synonyms').where('taxonomy_node_id', '=', id).execute();
      await db.updateTable('taxonomy.taxonomy_nodes').set({ merged_into_id: null }).where('merged_into_id', '=', id).execute();
      await db.updateTable('taxonomy.taxonomy_nodes').set({ merged_into_id: null, status: 'inactive' }).where('id', '=', id).execute();
      await db.deleteFrom('taxonomy.taxonomy_nodes').where('id', '=', id).execute();
    }),
  );
}

async function symptom(h: Harness): Promise<string> {
  const [row] = await h.q<{ id: string }>(
    sql`SELECT id FROM taxonomy.taxonomy_nodes WHERE type = 'symptom' AND status = 'active' ORDER BY id LIMIT 1`,
  );
  return row!.id;
}

export const resolvers: Resolvers = {
  'taxonomy.version': async (h) => ({ as: await h.anonymous() }),
  'taxonomy.snapshot': async (h) => ({ as: await h.anonymous(), query: { type: 'service_system' } }),
  'taxonomy.node_get': async (h) => ({ as: await h.anonymous(), params: { node_id: h.n.system } }),
  'taxonomy.suggest': async (h) => ({
    as: await h.anonymous(),
    body: { text: 'brak', types: ['symptom', 'service_system'] },
    headers: { 'accept-language': 'en' },
  }),
  'admin.taxonomy_node_create': async (h) => {
    const as = await admin(h);
    return {
      as,
      body: {
        type: 'service_system',
        name_translations: { en: 'Sweep node', fa: 'گره آزمون' },
        slug: `sweep-new-${h.newId().slice(-10)}`,
        reason: REASON,
      },
      check: (res) => removeNodeAtClose(h, res.body.id as string),
    };
  },
  'admin.taxonomy_node_update': async (h) => {
    const as = await admin(h);
    const node = await tempNode(h, as);
    return { as, params: { node_id: node.id }, version: node.version, body: { sort_order: 7, reason: REASON } };
  },
  'admin.taxonomy_merge': async (h) => {
    const as = await admin(h);
    const [from, into] = [await tempNode(h, as), await tempNode(h, as)];
    return { as, params: { node_id: from.id }, body: { into_node_id: into.id, reason: REASON } };
  },
  'admin.synonyms_list': async (h) => ({ as: await h.staff('platform_moderator'), params: { node_id: h.n.system } }),
  'admin.synonym_create': async (h) => {
    const as = await admin(h);
    const node = await tempNode(h, as);
    return { as, params: { node_id: node.id }, body: { term: 'swp sys', locale: 'en', synonym_type: 'abbreviation', reason: REASON } };
  },
  'admin.synonym_decide': async (h) => {
    const as = await admin(h);
    const node = await tempNode(h, as);
    const id = h.newId();
    await h.sys((db) =>
      db
        .insertInto('taxonomy.taxonomy_synonyms')
        .values({
          id,
          taxonomy_node_id: node.id,
          term: 'sweep pending',
          locale: 'en',
          synonym_type: 'synonym',
          source: 'ai_suggested',
          status: 'pending_review',
        })
        .execute(),
    );
    return { as: await h.staff('platform_moderator'), params: { synonym_id: id }, body: { decision: 'approve', reason: REASON } };
  },
  'admin.synonym_delete': async (h) => {
    const as = await admin(h);
    const node = await tempNode(h, as);
    const syn = ok(
      await as.c.post(`/v1/admin/taxonomy/nodes/${node.id}/synonyms`, {
        term: 'swp del',
        locale: 'en',
        synonym_type: 'abbreviation',
        reason: REASON,
      }),
      'synonym',
    );
    return { as, params: { synonym_id: syn.id as string }, headers: { 'carpal-reason': 'Duplicate of an alias' } };
  },
  'admin.mappings_list': async (h) => ({ as: await h.staff('platform_moderator'), query: { mapping_type: 'symptom_to_system' } }),
  'admin.mapping_upsert': async (h) => {
    const as = await admin(h);
    const node = await tempNode(h, as);
    return {
      as,
      body: { source_node_id: await symptom(h), target_node_id: node.id, mapping_type: 'symptom_to_system', weight: 40, reason: REASON },
    };
  },
};
