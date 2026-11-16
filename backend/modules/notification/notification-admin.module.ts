// Notification operations of the admin plane (40 §23.5, backend S17) on admin-api: templates, rules, Delivery health
// (S25a) and the caller's staff notices.
import { Module } from '@nestjs/common';
import {
  NotifDeliveryHealthHandler,
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
    NotifDeliveryHealthHandler,
    StaffNotificationsListHandler,
    StaffNotificationsUnreadCountHandler,
    StaffNotificationsMarkReadHandler,
  ],
})
export class NotificationAdminModule {}
