// notification module (41 §2.1 M13; 40 §20; W5). Four Nest modules share this folder:
//   NotificationModule           (global, every deployable) the dispatcher and
//                                the W5 consumer (subscribed on the worker only).
//   NotificationMessagingModule  Messenger: EN/FA transactional mails and texts
//                                (also on the auth host).
//   NotificationApiModule        §20 operations on the api host.
//   NotificationWorkerModule     W15 rules (delivery retry, digests); hosted by
//                                workers/notification-dispatch.
import { Global, Module } from '@nestjs/common';
import { NotificationDispatcher } from './application/dispatcher.js';
import { NotificationDispatchConsumer } from './events/dispatch.consumer.js';

@Global()
@Module({
  providers: [NotificationDispatcher, NotificationDispatchConsumer],
  exports: [NotificationDispatcher],
})
export class NotificationModule {}
