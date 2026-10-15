// identity module (41 §2.1 M1). Three Nest modules share this folder:
//   IdentityModule         (global, every deployable) the ports identity serves:
//                          MembershipDirectory (L4), ConsentChecker (L16),
//                          UserCards, ConsentScopes, OrgMemberships,
//                          ConsentRequests, ConsentGrants, ATT verification, and the
//                          services shared by the two others.
//   IdentityAccountModule  §6.3-§6.6 on the api host (identity-account.module.ts)
//   IdentityAuthModule     §6.2 on the auth host (identity-auth.module.ts)
//   IdentityAdminModule    §23.2 users and §23.5 data subject requests on the
//                          admin-api host (identity-admin.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { Authorizer, MembershipDirectory } from '#libs/authz/index.js';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import type { Infra } from '#libs/infra/index.js';
import { AttestationVerifierPort, INFRA } from '#libs/runtime/index.js';
import { FourEyesExecutors, ModerationTargets, PurposeQueues, retentionCutoff, RetentionHandlers } from '#modules/admin/interface/admin.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { UsageCounters } from '#modules/billing/interface/billing.js';
import { DbAccountAdmin, grantPlatformRole, startDeletion } from './application/admin-ops.js';
import { DsrDeadlineRule, DsrDeletionConsumer, DsrExporter, identityPersonalData } from './application/dsr-worker.js';

export { DSR_EXPORT_QUEUE } from './application/admin-ops.js';
export { DsrExporter };
import { MfaService } from './application/mfa-service.js';
import { PowAttestationVerifier } from './infrastructure/attestation.js';
import { AuthState } from './infrastructure/auth-state.js';
import { DbAccountFacts, DbConsentChecker, DbConsentGrants, DbUserCards } from './infrastructure/directory.js';
import { DbMembershipDirectory } from './infrastructure/membership-directory.js';
import { IdentityMessages } from './infrastructure/messages.js';
import { DbRecipients } from './infrastructure/recipients.js';
import { DbConsentRequests, DbOrgMemberships, requestedOfUser } from './infrastructure/org-memberships.js';
import {
  AccountAdmin,
  AccountFacts,
  ConsentGrants,
  ConsentRequests,
  ConsentScopes,
  OrgMemberships,
  PersonalDataRegistry,
  Recipients,
  UserCards,
} from './interface/identity.js';

/**
 * Registers the fleet-users counter (entitlement max_fleet_users,
 * Subscription.usage.users) where billing runs, and the consent scope of
 * portfolio items: showcase consent is granted only in answer to a
 * business's cn request (the request names the item and the customer).
 */
@Injectable()
export class IdentityUsageRegistration implements OnModuleInit {
  constructor(
    private readonly scopes: ConsentScopes,
    @Optional() private readonly counters?: UsageCounters,
  ) {}

  onModuleInit(): void {
    this.scopes.register('portfolio_item', (scope, userId, id) => requestedOfUser(scope, 'portfolio_item', userId, id));
    this.counters?.register('max_fleet_users', async (scope, subscriber) => {
      if (subscriber.type !== 'organization') return 0;
      const row = await scope.db
        .selectFrom('identity.role_memberships')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('organization_id', '=', subscriber.id)
        .where('status', 'in', ['active', 'invited'])
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    });
  }
}

/**
 * Admin-plane registrations (S8): the dsr purpose queue (SEC-ADM-5), the
 * four-eyes executors of platform role grants and DSR deletions, identity's
 * own DSR export/erase handler, the moderation target 'user' and the
 * VerificationToken retention policy.
 */
@Injectable()
export class IdentityAdminRegistrations implements OnModuleInit {
  constructor(
    private readonly personal: PersonalDataRegistry,
    private readonly authorizer: Authorizer,
    private readonly cards: UserCards,
    @Optional() private readonly purposes?: PurposeQueues,
    @Optional() private readonly executors?: FourEyesExecutors,
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly gauges?: MetricGauges,
  ) {}

  onModuleInit(): void {
    this.gauges?.register('gauge.users_active', async (scope) =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*) AS n FROM identity.user_accounts WHERE status = 'active' AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    this.gauges?.register('gauge.dsr_open', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM identity.data_subject_requests WHERE status IN ('received','verifying_identity','in_progress') AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    this.personal.register('identity', identityPersonalData);
    this.purposes?.register('dsr', async (scope, staffUserId, id) => {
      const d = await scope.db
        .selectFrom('identity.data_subject_requests')
        .select(['status', 'handled_by'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // DSRs form one shared queue of admins and support (52 DataSubjectRequest.handled_by records who acted last).
      return !!d && !['completed', 'rejected'].includes(d.status);
    });
    this.executors?.register('admin.platform_role_grant', async (scope, c) =>
      grantPlatformRole(scope, this.authorizer, String(c.payload.user_id), String(c.payload.role), c.reason),
    );
    this.executors?.register('admin.dsr_execute_deletion', async (scope, c) => startDeletion(scope, c.targetId, c.approvedBy));
    this.targets?.register('user', {
      // The user_cards definer: any signed-in user can report an account they met, never reading it.
      exists: async (scope, id) => {
        const card = (await this.cards.cards(scope, [id])).get(id);
        return !!card && card.status !== 'deleted';
      },
      snapshot: async (scope, id) => {
        const u = await scope.db
          .selectFrom('identity.user_accounts')
          .select(['id', 'display_name', 'status', 'created_at', 'trusted_user'])
          .where('id', '=', id)
          .executeTakeFirst();
        return u
          ? {
              type: 'user',
              id: u.id,
              display_name: u.display_name,
              status: u.status,
              created_at: u.created_at.toISOString(),
              trusted_user: u.trusted_user,
            }
          : null;
      },
      author: async (_scope, id) => id,
    });
    this.retention?.register('VerificationToken', async (scope, p) => {
      const r = await sql`DELETE FROM identity.verification_tokens WHERE created_at < ${retentionCutoff(p)}`.execute(scope.db);
      return Number(r.numAffectedRows ?? 0);
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: MembershipDirectory, useClass: DbMembershipDirectory },
    { provide: ConsentChecker, useClass: DbConsentChecker },
    { provide: UserCards, useClass: DbUserCards },
    // One registry per application context (contexts share a process in pnpm dev and tests).
    { provide: ConsentScopes, useFactory: () => new ConsentScopes() },
    { provide: OrgMemberships, useClass: DbOrgMemberships },
    { provide: AccountFacts, useClass: DbAccountFacts },
    { provide: ConsentRequests, useClass: DbConsentRequests },
    { provide: ConsentGrants, useClass: DbConsentGrants },
    { provide: Recipients, useClass: DbRecipients },
    {
      provide: AuthState,
      useFactory: (infra: Infra, c: CryptoServices) => new AuthState(infra.kv, c.hmac),
      inject: [INFRA, CryptoServices],
    },
    { provide: AttestationVerifierPort, useClass: PowAttestationVerifier },
    IdentityMessages,
    MfaService,
    IdentityUsageRegistration,
    { provide: PersonalDataRegistry, useFactory: () => new PersonalDataRegistry() },
    { provide: AccountAdmin, useClass: DbAccountAdmin },
    IdentityAdminRegistrations,
    DsrDeletionConsumer,
  ],
  exports: [
    MembershipDirectory,
    ConsentChecker,
    UserCards,
    ConsentScopes,
    OrgMemberships,
    AccountFacts,
    ConsentRequests,
    ConsentGrants,
    Recipients,
    AuthState,
    AttestationVerifierPort,
    IdentityMessages,
    MfaService,
    PersonalDataRegistry,
    AccountAdmin,
  ],
})
export class IdentityModule {}

/** Identity work on the worker deployable: the W8 DSR export bundle (hosted by workers/export-jobs) and the daily DSR deadline alert (W15). */
@Module({ providers: [DsrExporter, DsrDeadlineRule], exports: [DsrExporter, DsrDeadlineRule] })
export class IdentityWorkerModule {}
