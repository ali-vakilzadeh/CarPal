// notification module (41 §2.1 M13; 40 §20; W5). Five Nest modules share this folder:
//   NotificationModule           (global, every deployable) the dispatcher,
//                                the W5 consumer (subscribed on the worker only)
//                                and the notification rules (S17) other modules read.
//   NotificationMessagingModule  Messenger: EN/FA transactional mails and texts
//                                (also on the auth host).
//   NotificationApiModule        §20 operations on the api host.
//   NotificationAdminModule      §23.5 templates, rules and staff notices on admin-api (S17).
//   NotificationWorkerModule     W15 rules (delivery retry, digests); hosted by
//                                workers/notification-dispatch.
import { Global, Module } from '@nestjs/common';
import { NotificationDispatcher } from './application/dispatcher.js';
import { NotificationDispatchConsumer } from './events/dispatch.consumer.js';
import { NotificationAdminRegistrations } from './application/admin-registrations.js';
import { DbNotificationRules } from './infrastructure/notification-store.js';
import { NotificationRulesRead } from './interface/notification-rules.js';
import { DbPushDevices } from './infrastructure/push-devices.js';
import { PushDevicesRead } from './interface/push-devices.js';

@Global()
@Module({
  providers: [
    NotificationAdminRegistrations,
    NotificationDispatcher,
    NotificationDispatchConsumer,
    { provide: NotificationRulesRead, useClass: DbNotificationRules },
    // Backend S23 (BR-16): push devices on admin.user_sessions.
    { provide: PushDevicesRead, useClass: DbPushDevices },
  ],
  exports: [NotificationDispatcher, NotificationRulesRead, PushDevicesRead],
})
export class NotificationModule {}
