// W15 rules of the notification module (41 §6.3), system context:
//   notification.delivery_retry (every 5 min) sends queued deliveries that
//     missed their first attempt and retries failed ones (at most 3 attempts).
//   notification.digests (hourly) sends daily and weekly email digests.
//   notification.sms_status (every 2 min, S26a) records the provider's delivered/failed answer on sent SMS.
//   notification.sms_simulated_warning (hourly, S26a, DQ-28) warns outside dev while SMS is a mock.
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import type { Infra } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectConfig, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
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

@Injectable()
export class SmsStatusRule extends ScheduledRule {
  readonly name = 'notification.sms_status';
  readonly everyMs = 2 * 60_000;

  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  run(): Promise<number> {
    return this.dispatcher.pollSmsStatus();
  }
}

/**
 * DQ-28 (S26a.T3): outside dev a simulated SMS provider (mock, file) is allowed, but every hour the log says that no
 * text message leaves the server; admin.system_health shows the provider too.
 */
@Injectable()
export class SmsSimulatedWarningRule extends ScheduledRule {
  readonly name = 'notification.sms_simulated_warning';
  readonly everyMs = 60 * 60_000;

  constructor(
    @InjectInfra() private readonly infra: Infra,
    @InjectConfig() private readonly config: CarpalConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  run(): Promise<number> {
    if (this.config.env === 'dev' || !this.infra.smsGateway.simulated) return Promise.resolve(0);
    this.logger.warn(
      { sms_provider: this.infra.smsGateway.provider },
      'SMS provider is simulated: no text message leaves this server (sign-in and notification codes are only in outbox-sms.jsonl)',
    );
    return Promise.resolve(1);
  }
}
