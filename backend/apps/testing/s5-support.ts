// Shared helpers of the S5 integration tests (vehicles, inventory): a JSON
// request client with the usual headers, outbox and audit reads through the
// fixtures' worker connection, and request bodies.
import { sql } from 'kysely';
import { uuidv7 } from '#libs/crypto/index.js';
import type { Nodes } from './s4-support.js';
import { idem, type Json } from './s4-support.js';
import type { TestApp } from './test-app.js';

export function client(app: TestApp, token: string) {
  return {
    get: (path: string, headers: Record<string, string> = {}) => app.request<Json>({ path, token, headers }),
    post: (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request<Json>({ method: 'POST', path, token, headers: { ...idem(), ...headers }, ...(body !== undefined ? { body } : {}) }),
    put: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request<Json>({ method: 'PUT', path, token, body, headers }),
    patch: (path: string, body: unknown, etag: string | number) =>
      app.request<Json>({ method: 'PATCH', path, token, body, headers: { 'if-match': typeof etag === 'number' ? `"v${etag}"` : etag } }),
    del: (path: string) => app.request<Json>({ method: 'DELETE', path, token }),
  };
}
export type Client = ReturnType<typeof client>;

/** Event types in the outbox for an aggregate, oldest first. */
export async function outbox(app: TestApp, aggregateId: string): Promise<{ type: string; payload: Json }[]> {
  const rows = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    db
      .selectFrom('core.domain_event_outbox')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', aggregateId)
      .orderBy('occurred_at')
      .orderBy('event_id')
      .execute(),
  );
  return rows.map((r) => ({ type: r.event_type, payload: r.payload as Json }));
}

/** Audit actions written for an entity. */
export async function audits(app: TestApp, entityId: string): Promise<string[]> {
  const { rows } = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    sql<{ action: string }>`SELECT action FROM analytics.audit_logs WHERE entity_id = ${entityId}::uuid ORDER BY created_at`.execute(db),
  );
  return rows.map((r) => r.action);
}

export const vehicleBody = (n: Nodes, o: Json = {}) => ({ brand_node_id: n.brand, model_node_id: n.model, year: 2019, ...o });

/** A consent the user grants through consents.grant (API), e.g. vehicle_data_sharing to a provider. */
export async function grantConsent(
  c: Client,
  type: string,
  scope: { type: string; id: string } | null,
  grantee: string | null,
): Promise<string> {
  const res = await c.post('/v1/me/consents', {
    consent_type: type,
    policy_version: '2026-10',
    ...(scope ? { scope } : {}),
    ...(grantee ? { granted_to: { type: 'organization', id: grantee } } : {}),
  });
  if (res.status !== 201) throw new Error(`consents.grant ${res.status} ${res.text}`);
  return res.body.id as string;
}

export const newId = uuidv7;
