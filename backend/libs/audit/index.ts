// L15 audit (41 §2.2, 7; 40 SEC-LOG-3/4, SEC-ADM-3): `AUD` entries go to
// analytics.audit_logs through analytics.write_audit() in the same
// transaction as the change, so an audited change cannot commit without its
// entry. Actor, organization and request id come from the RLS context. Staff
// reads of PII write a `pii.read` entry with the access purpose.
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';

const ACTION = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export interface AuditEntry {
  /** e.g. "vehicle.vin_revealed", "admin.flag_updated" (dot-separated, ≤ 80). */
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  /** Short summaries (≤ 2000), never full records or secrets. */
  previous?: string | null;
  next?: string | null;
  /** "case:<id>" … (CarPal-Access-Purpose), required for pii.read. */
  accessPurpose?: string | null;
}

export const AUDIT_MARK = 'audit';

export async function writeAudit(scope: TxScope, e: AuditEntry): Promise<string> {
  if (!ACTION.test(e.action) || e.action.length > 80) throw new Error(`invalid audit action ${e.action}`);
  const { rows } = await sql<{ id: string }>`
    SELECT analytics.write_audit(${e.action}, ${e.entityType}, ${e.entityId}::uuid, ${e.reason ?? null},
                                 ${e.previous ?? null}, ${e.next ?? null}, ${e.accessPurpose ?? null}) AS id`.execute(scope.db);
  scope.marks.add(AUDIT_MARK);
  return rows[0]!.id;
}

/** SEC-LOG-4: a staff read of a PII response (actor, purpose, entity, fields group). */
export function auditPiiRead(
  scope: TxScope,
  e: { entityType: string; entityId: string; accessPurpose: string; fieldsGroup: string },
): Promise<string> {
  return writeAudit(scope, {
    action: 'pii.read',
    entityType: e.entityType,
    entityId: e.entityId,
    next: e.fieldsGroup,
    accessPurpose: e.accessPurpose,
  });
}
