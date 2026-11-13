// Admin plane services behind the admin interface: pending four-eyes changes
// (admin.pending_admin_changes), the append-only moderation log
// (admin.moderation_actions) and the purpose verifier of the authorizer
// (libs/authz PurposeVerifier, SEC-ADM-5).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import type { AccessPurpose, PurposeVerdict, PurposeVerifier } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { toPendingChange, type PendingChangeRow } from '../api/projections.js';
import {
  FourEyes,
  ModerationIntake,
  ModerationLog,
  PurposeBindings,
  PurposeQueues,
  PurposeSubjects,
  StaffNames,
  subjectKey,
  type AutomatedFlag,
  type SubjectRef,
  type ModerationActionRecord,
  type PendingChangeRequest,
  type PendingChangeView,
  type TrustPenaltyInput,
} from '../interface/admin.js';

registerConstraintErrors({
  pending_admin_changes_four_eyes: 'SELF_APPROVAL_FORBIDDEN',
  content_reports_open_uq: 'DUPLICATE',
  assist_sessions_active_uq: 'DUPLICATE',
});

@Injectable()
export class DbFourEyes extends FourEyes {
  constructor(private readonly names: StaffNames) {
    super();
  }

  async request(scope: TxScope, staffUserId: string, r: PendingChangeRequest, locale: string): Promise<PendingChangeView> {
    const open = await scope.db
      .selectFrom('admin.pending_admin_changes')
      .select('id')
      .where('op_id', '=', r.opId)
      .where('target_entity_id', '=', r.targetId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', new Date())
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (open) throw new ApiError('DUPLICATE', { detail: `a pending ${r.opId} change exists for this target` });
    const row = (await scope.db
      .insertInto('admin.pending_admin_changes')
      .values({
        op_id: r.opId,
        target_entity_type: r.targetType,
        target_entity_id: r.targetId,
        request_payload: JSON.stringify(r.payload),
        summary: r.summary.slice(0, 1000),
        reason: r.reason,
        requested_by: staffUserId,
        required_role: r.requiredRole,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as PendingChangeRow;
    await writeAudit(scope, {
      action: 'admin.four_eyes_requested',
      entityType: r.targetType,
      entityId: r.targetId,
      reason: r.reason,
      next: `${r.opId} pending (change ${row.id})`,
    });
    return toPendingChange(row, await this.names.names(scope, [staffUserId], locale));
  }

  async rejectRequestsOf(scope: TxScope, requesterUserId: string, decidedBy: string, reason: string): Promise<number> {
    const rows = await scope.db
      .updateTable('admin.pending_admin_changes')
      .set({ status: 'rejected', decided_by: decidedBy, decision_reason: reason, decided_at: sql<Date>`now()` })
      .where('requested_by', '=', requesterUserId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', new Date())
      .where('deleted_at', 'is', null)
      .returning(['id', 'op_id', 'target_entity_type', 'target_entity_id', 'reason'])
      .execute();
    for (const c of rows)
      await writeAudit(scope, {
        action: 'admin.four_eyes_rejected',
        entityType: c.target_entity_type,
        entityId: c.target_entity_id,
        reason,
        previous: `${c.op_id} requested by ${requesterUserId}: ${c.reason}`.slice(0, 2000),
        next: `rejected by ${decidedBy} (change ${c.id})`,
      });
    return rows.length;
  }
}

@Injectable()
export class DbModerationLog extends ModerationLog {
  async record(scope: TxScope, a: ModerationActionRecord): Promise<string> {
    const row = await scope.db
      .insertInto('admin.moderation_actions')
      .values({
        moderation_case_id: a.caseId ?? null,
        target_entity_type: a.targetType,
        target_entity_id: a.targetId,
        action_type: a.actionType,
        reason: a.reason,
        params: a.params ? JSON.stringify(a.params) : null,
        actor_user_id: a.actorUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async penalties(scope: TxScope, orgId: string, since: Date): Promise<TrustPenaltyInput[]> {
    // Actions on the organization itself or on content whose subject organization was recorded in params.
    // A later restore of the same record lifts a content penalty; apply_trust_penalty may carry its own expiry.
    const { rows } = await sql<{ id: string; action_type: string; params: Record<string, unknown> | null; created_at: Date }>`
      SELECT a.id, a.action_type, a.params, a.created_at
        FROM admin.moderation_actions a
       WHERE a.created_at >= ${since}
         AND ((a.target_entity_type = 'organization' AND a.target_entity_id = ${orgId}::uuid)
              OR a.params ->> 'subject_organization_id' = ${orgId})
         AND a.action_type IN ('apply_trust_penalty', 'remove', 'hide')
         AND (a.params ->> 'expires_at' IS NULL OR (a.params ->> 'expires_at')::timestamptz > now())
         AND NOT EXISTS (SELECT 1 FROM admin.moderation_actions r
                          WHERE r.action_type = 'restore' AND r.target_entity_id = a.target_entity_id AND r.created_at > a.created_at)
       ORDER BY a.created_at`.execute(scope.db);
    return rows.map((r): TrustPenaltyInput => {
      const p = r.params ?? {};
      if (r.action_type === 'apply_trust_penalty')
        return { actionId: r.id, kind: 'admin_trust_penalty', points: Number(p.trust_penalty_points) || 0, createdAt: r.created_at };
      if (p.fake === true) return { actionId: r.id, kind: 'fake_review', points: 50, createdAt: r.created_at };
      return { actionId: r.id, kind: 'content_violation', points: 20, createdAt: r.created_at };
    });
  }

  async get(scope: TxScope, id: string) {
    const a = await scope.db
      .selectFrom('admin.moderation_actions')
      .select(['target_entity_type', 'target_entity_id', 'action_type', 'actor_user_id', 'params'])
      .where('id', '=', id)
      .executeTakeFirst();
    return a
      ? {
          targetType: a.target_entity_type,
          targetId: a.target_entity_id,
          actionType: a.action_type,
          actorUserId: a.actor_user_id,
          params: (a.params as Record<string, unknown> | null) ?? {},
        }
      : null;
  }

  async affects(scope: TxScope, actionId: string): Promise<{ userId: string | null; organizationId: string | null } | null> {
    const { rows } = await sql<{ user_id: string | null; organization_id: string | null }>`
      SELECT user_id, organization_id FROM admin.moderation_action_affects(${actionId}::uuid)`.execute(scope.db);
    const r = rows[0];
    return r ? { userId: r.user_id, organizationId: r.organization_id } : null;
  }

  reportsAgainst(scope: TxScope, targetType: string, targetId: string, reason?: string): Promise<number> {
    let q = scope.db
      .selectFrom('admin.content_reports')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('deleted_at', 'is', null);
    if (reason) q = q.where('reason', '=', reason);
    return count(q.executeTakeFirst());
  }

  openCases(scope: TxScope, targetType: string, targetId: string): Promise<number> {
    return count(
      scope.db
        .selectFrom('admin.moderation_cases')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('target_entity_type', '=', targetType)
        .where('target_entity_id', '=', targetId)
        .where('status', 'in', ['open', 'investigating', 'escalated'])
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
  }
}

/** Counts for staff views. */
async function count(q: Promise<{ n: string | number | bigint } | undefined>): Promise<number> {
  return Number((await q)?.n ?? 0);
}

/** The subjects of a purpose item: the item itself first, then what its queue names (backend S14). */
async function subjectsOf(queues: PurposeQueues, scope: TxScope, purpose: Pick<AccessPurpose, 'kind' | 'id'>): Promise<SubjectRef[]> {
  const queue = queues.get(purpose.kind);
  const own: SubjectRef = { type: purpose.kind, id: purpose.id };
  if (!queue) return [own];
  const seen = new Set([subjectKey(own)]);
  const out = [own];
  for (const s of await queue.subjects(scope, purpose.id))
    if (s.id && !seen.has(subjectKey(s))) {
      seen.add(subjectKey(s));
      out.push(s);
    }
  return out;
}

/**
 * SEC-ADM-5: a purpose header must name an open item in the staff member's
 * queue (else 404), and the record of the request must be one of that item's
 * subjects (else 403 PURPOSE_RECORD_MISMATCH; backend S14, BR-09, RCP-01).
 * Each kind is resolved by the module that owns the queue (PurposeQueues), each
 * operation's record by PurposeBindings; an unregistered kind or operation fails
 * closed.
 */
@Injectable()
export class QueuePurposeVerifier implements PurposeVerifier {
  constructor(
    private readonly tx: TxRunner,
    private readonly queues: PurposeQueues,
    private readonly bindings: PurposeBindings,
  ) {}

  async verify(staffUserId: string, purpose: AccessPurpose, opId: string, params: Record<string, string>): Promise<PurposeVerdict> {
    const queue = this.queues.get(purpose.kind);
    if (!queue) return { status: 'not_in_queue' };
    const binding = this.bindings.get(opId);
    return this.tx.run(
      { actorType: 'staff', userId: staffUserId },
      async (scope): Promise<PurposeVerdict> => {
        if (!(await queue.open(scope, staffUserId, purpose.id, opId))) return { status: 'not_in_queue' };
        if (!binding) return { status: 'record_mismatch' };
        const records = await binding(scope, params);
        if (records === 'scoped') return { status: 'ok', bound: null };
        const subjects = new Set((await subjectsOf(this.queues, scope, purpose)).map(subjectKey));
        const hit = records.map(subjectKey).find((k) => subjects.has(k));
        return hit ? { status: 'ok', bound: hit } : { status: 'record_mismatch' };
      },
      { readOnly: true },
    );
  }
}

@Injectable()
export class DbPurposeSubjects extends PurposeSubjects {
  constructor(private readonly queues: PurposeQueues) {
    super();
  }

  of(scope: TxScope, purpose: AccessPurpose): Promise<SubjectRef[]> {
    return subjectsOf(this.queues, scope, purpose);
  }
}

@Injectable()
export class DbModerationIntake extends ModerationIntake {
  async open(scope: TxScope, f: AutomatedFlag): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity, ai_risk_score, ai_flag_insight_id)
      SELECT ${f.targetType}, ${f.targetType}, ${f.targetId}::uuid, ${f.insightId ? 'ai_flag' : 'system_rule'}, ${f.reason}, ${f.severity},
             ${f.riskScore}, ${f.insightId}::uuid
       WHERE NOT EXISTS (SELECT 1 FROM admin.moderation_cases c
                          WHERE c.target_entity_type = ${f.targetType} AND c.target_entity_id = ${f.targetId}::uuid
                            AND c.status IN ('open','investigating','escalated') AND c.deleted_at IS NULL)
      RETURNING id`.execute(scope.db);
    return rows[0]?.id ?? null;
  }
}
