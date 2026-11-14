// Notification operations of the admin plane (40 §23.5, backend S17) on admin-api: templates, rules and the caller's
// staff notices.
import { Module } from '@nestjs/common';
import {
  NotifRulesGetHandler,
  NotifRulesUpdateHandler,
  NotifTemplatePreviewHandler,
  NotifTemplateResetHandler,
  NotifTemplatesListHandler,
  NotifTemplateUpdateHandler,
  StaffNotificationsListHandler,
  StaffNotificationsMarkReadHandler,
  StaffNotificationsUnreadCountHandler,
} from './application/admin-ops.js';

@Module({
  providers: [
    NotifTemplatesListHandler,
    NotifTemplateUpdateHandler,
    NotifTemplateResetHandler,
    NotifTemplatePreviewHandler,
    NotifRulesGetHandler,
    NotifRulesUpdateHandler,
    StaffNotificationsListHandler,
    StaffNotificationsUnreadCountHandler,
    StaffNotificationsMarkReadHandler,
  ],
})
export class NotificationAdminModule {}
