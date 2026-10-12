// identity module (41 §2.1 M1). Three Nest modules share this folder:
//   IdentityModule         (global, every deployable) the ports identity serves:
//                          MembershipDirectory (L4), ConsentChecker (L16),
//                          UserCards, ConsentScopes, OrgMemberships,
//                          ConsentRequests, ConsentGrants, ATT verification, and the
//                          services shared by the two others.
//   IdentityAccountModule  §6.3-§6.6 on the api host (identity-account.module.ts)
//   IdentityAuthModule     §6.2 on the auth host (identity-auth.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { MembershipDirectory } from '#libs/authz/index.js';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import type { Infra } from '#libs/infra/index.js';
import { AttestationVerifierPort, INFRA } from '#libs/runtime/index.js';
import { UsageCounters } from '#modules/billing/interface/billing.js';
import { MfaService } from './application/mfa-service.js';
import { PowAttestationVerifier } from './infrastructure/attestation.js';
import { AuthState } from './infrastructure/auth-state.js';
import { DbAccountFacts, DbConsentChecker, DbConsentGrants, DbUserCards } from './infrastructure/directory.js';
import { DbMembershipDirectory } from './infrastructure/membership-directory.js';
import { IdentityMessages } from './infrastructure/messages.js';
import { DbRecipients } from './infrastructure/recipients.js';
import { DbConsentRequests, DbOrgMemberships, requestedOfUser } from './infrastructure/org-memberships.js';
import {
  AccountFacts,
  ConsentGrants,
  ConsentRequests,
  ConsentScopes,
  OrgMemberships,
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
  ],
})
export class IdentityModule {}
