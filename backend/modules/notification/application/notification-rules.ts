// W15 rules of the notification module (41 §6.3), system context:
//   notification.delivery_retry (every 5 min) sends queued deliveries that
//     missed their first attempt and retries failed ones (at most 3 attempts).
//   notification.digests (hourly) sends daily and weekly email digests.
import { Injectable } from '@nestjs/common';
import { ScheduledRule } from '#libs/jobs/index.js';
import { NotificationDispatcher } from './dispatcher.js';

@Injectable()
export class DeliveryRetryRule extends ScheduledRule {
  readonly name = 'notification.delivery_retry';
  readonly everyMs = 5 * 60_000;

  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  run(): Promise<number> {
    return this.dispatcher.deliver();
  }
}

@Injectable()
export class DigestRule extends ScheduledRule {
  readonly name = 'notification.digests';
  readonly everyMs = 60 * 60_000;

  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  run(): Promise<number> {
    return this.dispatcher.sendDigests();
  }
}
