// Shared helpers of the S8 integration tests (admin plane, moderation,
// fleet): a staff client (cp-web-admin, aal3 session), purpose headers,
// open moderation cases to bind purposes to, and system-context queries.
import { sql } from 'kysely';
import { uuidv7 } from '#libs/crypto/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { idem, type Json } from './s4-support.js';
import type { TestApp } from './test-app.js';

export const ADMIN_CLIENT = 'cp-web-admin/1.0.0 (web 17.4)';
export const REASON = 'Ticket 4711: checked with the customer';

export function staffApi(app: TestApp, token: string) {
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request<Json>({ method, path, token, client: ADMIN_CLIENT, headers, ...(body !== undefined ? { body } : {}) });
  return {
    get: (path: string, headers: Record<string, string> = {}) => req('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers: Record<string, string> = {}) => req('POST', path, body, { ...idem(), ...headers }),
    put: (path: string, body: unknown, headers: Record<string, string> = {}) => req('PUT', path, body, { ...idem(), ...headers }),
    patch: (path: string, body: unknown, version: number, headers: Record<string, string> = {}) =>
      req('PATCH', path, body, { 'if-match': `"v${version}"`, ...headers }),
    del: (path: string, headers: Record<string, string> = {}) => req('DELETE', path, undefined, headers),
  };
}
export type StaffApi = ReturnType<typeof staffApi>;

export async function staff(app: TestApp, ...roles: string[]): Promise<{ user: TestUser; c: StaffApi }> {
  const user = await app.fixtures.staff(...roles);
  return { user, c: staffApi(app, await app.fixtures.token(user, { staff: true })) };
}

export const purpose = (kind: string, id: string): Record<string, string> => ({ 'carpal-access-purpose': `${kind}:${id}` });

/** An open moderation case about a target (purpose header binding, SEC-ADM-5). */
export async function openCase(app: TestApp, o: { type?: string; targetId?: string } = {}): Promise<string> {
  const id = uuidv7();
  const type = o.type ?? 'user';
  await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    db
      .insertInto('admin.moderation_cases')
      .values({
        id,
        case_type: type,
        target_entity_type: type,
        target_entity_id: o.targetId ?? uuidv7(),
        source: 'admin',
        reason: 'other',
        severity: 'low',
      })
      .execute(),
  );
  return id;
}

/** Rows of a raw query in the system context (fixtures' worker connection). */
export async function query<T>(app: TestApp, q: ReturnType<typeof sql<T>>): Promise<T[]> {
  return app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => (await q.execute(db)).rows);
}

/** Event types of the outbox for an aggregate or a payload member. */
export async function events(
  app: TestApp,
  o: { aggregateId?: string; type?: string; payloadKey?: string; payloadValue?: string },
): Promise<{ type: string; payload: Json }[]> {
  const rows = await query<{ event_type: string; payload: Json }>(
    app,
    sql`SELECT event_type, payload FROM core.domain_event_outbox
         WHERE (${o.aggregateId ?? null}::uuid IS NULL OR aggregate_id = ${o.aggregateId ?? null}::uuid)
           AND (${o.type ?? null}::text IS NULL OR event_type = ${o.type ?? null})
           AND (${o.payloadKey ?? null}::text IS NULL OR payload ->> ${o.payloadKey ?? ''} = ${o.payloadValue ?? null})
         ORDER BY occurred_at, event_id`,
  );
  return rows.map((r) => ({ type: r.event_type, payload: r.payload }));
}
