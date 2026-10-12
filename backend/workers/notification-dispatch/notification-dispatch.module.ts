// W5 notification-dispatch host (41 §2.4): the notification module's consumer
// (routed S3-S6 events → notifications and deliveries) runs through the
// consumer registry; this host adds its W15 rules (delivery retry, digests).
import { Module } from '@nestjs/common';
import { NotificationWorkerModule } from '#modules/notification/notification-worker.module.js';

@Module({ imports: [NotificationWorkerModule] })
export class NotificationDispatchModule {}
