// user.registered → Individual Free subscription (41 §6.2; 52 Subscription
// "every user gets individual_free automatically"). Idempotent: the function
// creates the subscription only when the user has none.
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { ensureUserSubscription } from '../infrastructure/subscription-store.js';

@Injectable()
export class UserRegisteredBillingConsumer extends EventConsumer {
  readonly name = 'billing.user_registered';
  readonly subjects = ['user.registered'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    await this.tx.run({ actorType: 'system', requestId: event.requestId }, (scope) => ensureUserSubscription(scope, event.aggregateId));
  }
}
