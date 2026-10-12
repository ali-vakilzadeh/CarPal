// billing module (41 §2.1 M3, 40 §10): plans, subscriptions, change
// requests, and the L17 entitlement check. Global so every module can inject
// EntitlementChecker, SubscriptionReader, SubscriptionWriter and UsageCounters.
import { Global, Module } from '@nestjs/common';
import { EntitlementChecker } from '#libs/entitlements/index.js';
import {
  PlansListHandler,
  SubscriptionChangeRequestHandler,
  SubscriptionMeGetHandler,
  SubscriptionOrgGetHandler,
} from './application/billing-ops.js';
import { BillingEntitlementChecker, DbSubscriptionWriter, SubscriptionService } from './application/subscriptions.js';
import { UserRegisteredBillingConsumer } from './events/user-registered.consumer.js';
import { SubscriptionReader, SubscriptionWriter, UsageCounters } from './interface/billing.js';

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
  ],
  exports: [UsageCounters, SubscriptionReader, SubscriptionWriter, EntitlementChecker],
})
export class BillingModule {}
