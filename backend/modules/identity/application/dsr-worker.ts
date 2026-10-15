// Data subject request execution in the worker (41 §2.4 W8, §6.2
// user.deletion.completed; 52 DataSubjectRequest, ActorPseudonym). The export
// bundle collects every module's PersonalData section into one private,
// encrypted CSV (section, record, field, value; formula-safe) owned by the
// user and delivered through dsr downloads. Deletion runs every module's
// erase handler, then anonymizes the account itself, completes the request
// and publishes user.deletion.completed. Both are idempotent: a retry after a
// partial run converges.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { SessionStore } from '#libs/auth/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { writeCsv } from '#libs/csv/index.js';
import type { EventEnvelope } from '#libs/infra/index.js';
import { ScheduledRule, type JobContext, type JobOutcome } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { EventConsumer, publishEvent } from '#libs/outbox/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { PersonalDataRegistry, type PersonalDataHandler, type PersonalDataSection } from '../interface/identity.js';

const value = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));

/** One CSV of every module's sections (long format: no column set to agree on across modules). */
export function bundleCsv(userId: string, sections: PersonalDataSection[]): Buffer {
  const rows: string[][] = [['section', 'record_id', 'field', 'value']];
  rows.push(['export', userId, 'generated_at', new Date().toISOString()]);
  for (const s of sections)
    for (const r of s.records) for (const [field, v] of Object.entries(r.fields)) rows.push([s.section, r.id, field, value(v)]);
  return Buffer.from(writeCsv(rows), 'utf8');
}

@Injectable()
export class DsrExporter {
  constructor(
    private readonly tx: TxRunner,
    private readonly registry: PersonalDataRegistry,
    private readonly media: MediaService,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const requestId = (ctx.job.input_summary as { data_subject_request_id?: string } | null)?.data_subject_request_id;
    if (!requestId) return { errorCode: 'INTERNAL' };
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const d = await scope.db
        .selectFrom('identity.data_subject_requests')
        .select(['id', 'user_id', 'status'])
        .where('id', '=', requestId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!d || d.status !== 'in_progress') return { errorCode: 'INVALID_TRANSITION' };
      const sections: PersonalDataSection[] = [];
      for (const [, h] of this.registry.entries()) if (h.export) sections.push(...(await h.export(scope, d.user_id)));
      const assetId = await this.media.storeGenerated(scope, {
        owner: { type: 'user', id: d.user_id },
        uploadedBy: ctx.job.owner_user_id ?? d.user_id,
        purpose: 'system_export',
        mime: 'text/csv',
        bytes: bundleCsv(d.user_id, sections),
      });
      await scope.db.updateTable('identity.data_subject_requests').set({ export_media_asset_id: assetId }).where('id', '=', d.id).execute();
      await writeAudit(scope, {
        action: 'dsr.export_built',
        entityType: 'data_subject_request',
        entityId: d.id,
        next: `${sections.length} sections, file ${assetId}`,
      });
      return { result: { type: 'data_subject_request', id: d.id } };
    });
  }
}

/** W8 / identity: runs an approved deletion (user.deletion.requested from admin.dsr_execute_deletion). */
@Injectable()
export class DsrDeletionConsumer extends EventConsumer {
  readonly name = 'identity.dsr_deletion';
  readonly subjects = ['user.deletion.requested'];

  constructor(
    private readonly tx: TxRunner,
    private readonly registry: PersonalDataRegistry,
    private readonly sessions: SessionStore,
    private readonly authorizer: Authorizer,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const userId = String(event.payload.user_id ?? '');
    const requestId = event.aggregateId;
    const done = await this.tx.run({ actorType: 'system' }, async (scope) => {
      const d = await scope.db
        .selectFrom('identity.data_subject_requests')
        .select(['id', 'status', 'user_id'])
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!d || d.user_id !== userId || d.status === 'completed') return false;
      let erased = 0;
      for (const [module, h] of this.registry.entries()) {
        if (!h.erase) continue;
        const n = await h.erase(scope, userId);
        erased += n;
        this.logger.debug({ module, n }, 'dsr erase');
      }
      await scope.db
        .updateTable('identity.data_subject_requests')
        .set({ status: 'completed', completed_at: sql<Date>`now()` })
        .where('id', '=', d.id)
        .execute();
      await writeAudit(scope, {
        action: 'dsr.deletion_completed',
        entityType: 'data_subject_request',
        entityId: d.id,
        next: `${erased} records deleted or anonymized`,
      });
      await publishEvent(scope, {
        type: 'user.deletion.completed',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { data_subject_request_id: d.id },
      });
      return true;
    });
    if (done) {
      await this.sessions.revokeAll(userId);
      await this.authorizer.invalidateUser(userId);
    }
  }
}

/** Identity's own part of DSRs: the account, preferences, memberships, consents and requests; erasure anonymizes the account. */
export const identityPersonalData: PersonalDataHandler = {
  async export(scope: TxScope, userId: string): Promise<PersonalDataSection[]> {
    const u = await scope.db.selectFrom('identity.user_accounts').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!u) return [];
    const [memberships, consents, requests] = await Promise.all([
      scope.db
        .selectFrom('identity.role_memberships')
        .select(['id', 'organization_id', 'role', 'status', 'joined_at'])
        .where('user_id', '=', userId)
        .execute(),
      scope.db
        .selectFrom('identity.consent_records')
        .select(['id', 'consent_type', 'scope_entity_type', 'scope_entity_id', 'granted', 'granted_at', 'withdrawn_at', 'policy_version'])
        .where('subject_type', '=', 'user')
        .where('subject_id', '=', userId)
        .execute(),
      scope.db
        .selectFrom('identity.data_subject_requests')
        .select(['id', 'request_type', 'status', 'requested_at', 'completed_at'])
        .where('user_id', '=', userId)
        .execute(),
    ]);
    return [
      {
        section: 'account',
        records: [
          {
            id: u.id,
            fields: {
              full_name: u.full_name,
              display_name: u.display_name,
              email: u.email,
              phone: u.phone,
              locale: u.locale,
              timezone: u.timezone,
              status: u.status,
              created_at: u.created_at.toISOString(),
              terms_version: u.terms_version,
              privacy_policy_version: u.privacy_policy_version,
            },
          },
        ],
      },
      {
        section: 'memberships',
        records: memberships.map((m) => ({
          id: m.id,
          fields: { organization_id: m.organization_id, role: m.role, status: m.status, joined_at: value(m.joined_at) },
        })),
      },
      {
        section: 'consents',
        records: consents.map((c) => ({
          id: c.id,
          fields: {
            consent_type: c.consent_type,
            scope_type: c.scope_entity_type,
            scope_id: c.scope_entity_id,
            granted: c.granted,
            granted_at: value(c.granted_at),
            withdrawn_at: value(c.withdrawn_at),
            policy_version: c.policy_version,
          },
        })),
      },
      {
        section: 'data_requests',
        records: requests.map((r) => ({
          id: r.id,
          fields: {
            request_type: r.request_type,
            status: r.status,
            requested_at: value(r.requested_at),
            completed_at: value(r.completed_at),
          },
        })),
      },
    ];
  },

  async erase(scope: TxScope, userId: string): Promise<number> {
    let n = 0;
    const del = async (q: Promise<{ numAffectedRows?: bigint }>) => {
      n += Number((await q).numAffectedRows ?? 0);
    };
    await del(sql`DELETE FROM identity.authentication_methods WHERE user_id = ${userId}::uuid`.execute(scope.db));
    await del(sql`DELETE FROM identity.verification_tokens WHERE user_id = ${userId}::uuid`.execute(scope.db));
    await del(sql`DELETE FROM identity.onboarding_progress WHERE user_id = ${userId}::uuid`.execute(scope.db));
    await del(
      sql`UPDATE identity.consent_records SET granted = false, withdrawn_at = coalesce(withdrawn_at, now())
           WHERE subject_type = 'user' AND subject_id = ${userId}::uuid AND granted`.execute(scope.db),
    );
    await del(
      sql`UPDATE identity.role_memberships SET status = 'removed' WHERE user_id = ${userId}::uuid AND status <> 'removed'`.execute(
        scope.db,
      ),
    );
    // The account row stays for references (reviews, appointments) but carries no personal data.
    await del(
      sql`UPDATE identity.user_accounts
             SET full_name = 'Deleted user', display_name = NULL, phone = NULL, phone_verified_at = NULL,
                 email = ${`deleted-${userId}@deleted.carpal.invalid`}, preferred_contact_channel = NULL,
                 status = 'deleted', mfa_enabled = false, anonymized_at = coalesce(anonymized_at, now()),
                 deleted_at = coalesce(deleted_at, now()), deletion_reason = 'data subject request'
           WHERE id = ${userId}::uuid`.execute(scope.db),
    );
    return n;
  },
};

/** 41 §6.3 daily: data subject requests due within 3 days → an alert to platform admins and support (dsr.deadline.approaching). */
@Injectable()
export class DsrDeadlineRule extends ScheduledRule {
  readonly name = 'identity.dsr_deadlines';
  readonly everyMs = 24 * 3_600_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const due = await scope.db
        .selectFrom('identity.data_subject_requests')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('status', 'in', ['received', 'verifying_identity', 'in_progress'])
        .where('due_at', '<', new Date(now.getTime() + 3 * 86_400_000))
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      const count = Number(due.n);
      if (count === 0) return 0;
      const staff = await scope.db
        .selectFrom('identity.role_memberships')
        .select('user_id')
        .where('role', 'in', ['platform_admin', 'platform_support'])
        .where('organization_id', 'is', null)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute();
      await publishEvent(scope, {
        type: 'dsr.deadline.approaching',
        aggregateType: 'data_subject_request',
        aggregateId: '00000000-0000-7000-8000-000000000000',
        payload: { request_count: count, staff_user_ids: [...new Set(staff.map((s) => s.user_id).filter((x): x is string => !!x))] },
      });
      return count;
    });
  }
}
