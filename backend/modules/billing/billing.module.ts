// billing module (41 §2.1 M3, 40 §10): plans, subscriptions, change
// requests, and the L17 entitlement check. Global so every module can inject
// EntitlementChecker, SubscriptionReader, SubscriptionWriter and UsageCounters.
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { EntitlementChecker } from '#libs/entitlements/index.js';
import { FourEyesExecutors } from '#modules/admin/interface/admin.js';
import {
  AdminPlansListHandler,
  AdminPlanUpdateHandler,
  AdminSubscriptionAssignHandler,
  applyPlanUpdate,
  TrialExpiryRule,
} from './application/admin-ops.js';
import {
  PlansListHandler,
  SubscriptionChangeRequestHandler,
  SubscriptionMeGetHandler,
  SubscriptionOrgGetHandler,
} from './application/billing-ops.js';
import { BillingEntitlementChecker, DbSubscriptionWriter, SubscriptionService } from './application/subscriptions.js';
import { UserRegisteredBillingConsumer } from './events/user-registered.consumer.js';
import { SubscriptionReader, SubscriptionWriter, UsageCounters } from './interface/billing.js';

/** The four-eyes executor of admin.plan_update (S8). */
@Injectable()
export class BillingAdminRegistrations implements OnModuleInit {
  constructor(@Optional() private readonly executors?: FourEyesExecutors) {}

  onModuleInit(): void {
    this.executors?.register('admin.plan_update', async (scope, c) =>
      applyPlanUpdate(scope, c.targetId, c.payload as Parameters<typeof applyPlanUpdate>[2], c.reason),
    );
  }
}

@Global()
@Module({
  providers: [
    // One registry per application context (several contexts share a process in pnpm dev and tests).
    { provide: UsageCounters, useFactory: () => new UsageCounters() },
    SubscriptionService,
    { provide: SubscriptionReader, useExisting: SubscriptionService },
    { provide: SubscriptionWriter, useClass: DbSubscriptionWriter },
    { provide: EntitlementChecker, useClass: BillingEntitlementChecker },
    PlansListHandler,
    SubscriptionMeGetHandler,
    SubscriptionOrgGetHandler,
    SubscriptionChangeRequestHandler,
    UserRegisteredBillingConsumer,
    BillingAdminRegistrations,
    // admin-api host (§23.2); other hosts skip them.
    AdminSubscriptionAssignHandler,
    AdminPlansListHandler,
    AdminPlanUpdateHandler,
  ],
  exports: [UsageCounters, SubscriptionReader, SubscriptionWriter, EntitlementChecker],
})
export class BillingModule {}

/** Billing W15 rules on the worker: trials past trial_ends_at → audience default plan (daily). */
@Module({ providers: [TrialExpiryRule], exports: [TrialExpiryRule] })
export class BillingWorkerModule {}

export { TrialExpiryRule };
