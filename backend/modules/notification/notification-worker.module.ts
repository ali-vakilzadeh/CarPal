// Notification work on the worker deployable: W15 rules (41 §6.3). The W5
// consumer itself is provided by NotificationModule and subscribed by the
// worker's consumer registry.
import { Module } from '@nestjs/common';
import { DeliveryRetryRule, DigestRule, SmsSimulatedWarningRule, SmsStatusRule } from './application/notification-rules.js';

export { DeliveryRetryRule, DigestRule, SmsSimulatedWarningRule, SmsStatusRule } from './application/notification-rules.js';

@Module({ providers: [DeliveryRetryRule, DigestRule, SmsSimulatedWarningRule, SmsStatusRule] })
export class NotificationWorkerModule {}
