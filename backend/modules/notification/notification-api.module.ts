// Notification operations (40 §20) on the api host.
import { Module } from '@nestjs/common';
import {
  NotificationPrefsGetHandler,
  NotificationPrefsPutHandler,
  NotificationsListHandler,
  NotificationsMarkReadHandler,
  NotificationsUnreadCountHandler,
  PushTokensRegisterHandler,
  PushTokensRevokeHandler,
} from './application/notification-ops.js';

@Module({
  providers: [
    NotificationsListHandler,
    NotificationsUnreadCountHandler,
    NotificationsMarkReadHandler,
    NotificationPrefsGetHandler,
    NotificationPrefsPutHandler,
    PushTokensRegisterHandler,
    PushTokensRevokeHandler,
  ],
})
export class NotificationApiModule {}
