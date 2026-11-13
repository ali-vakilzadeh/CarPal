// Identity operations on the admin-api host (40 §23.2 users and the staff
// directory, §23.5 data subject requests). Needs IdentityModule, AdminModule, BillingModule,
// OrganizationModule and TrustModule (global) in the same application.
import { Module } from '@nestjs/common';
import {
  AdminDsrExecuteDeletionHandler,
  AdminDsrExportHandler,
  AdminDsrQueueHandler,
  AdminDsrUpdateHandler,
  AdminOnboardingResetHandler,
  AdminPlatformRoleGrantHandler,
  AdminPlatformRoleRevokeHandler,
  AdminStaffMeHandler,
  AdminUserGetHandler,
  AdminUsersSearchHandler,
  AdminUserSessionsRevokeHandler,
  AdminUserStatusHandler,
  StaffUserViews,
} from './application/admin-ops.js';
import { DsrViews } from './application/privacy-ops.js';
import { AdminStaffDisableHandler, AdminStaffEnableHandler, AdminStaffListHandler } from './application/staff-ops.js';

@Module({
  providers: [
    StaffUserViews,
    DsrViews,
    AdminStaffMeHandler,
    AdminStaffListHandler,
    AdminStaffDisableHandler,
    AdminStaffEnableHandler,
    AdminUsersSearchHandler,
    AdminUserGetHandler,
    AdminUserStatusHandler,
    AdminUserSessionsRevokeHandler,
    AdminPlatformRoleGrantHandler,
    AdminPlatformRoleRevokeHandler,
    AdminOnboardingResetHandler,
    AdminDsrQueueHandler,
    AdminDsrUpdateHandler,
    AdminDsrExportHandler,
    AdminDsrExecuteDeletionHandler,
  ],
})
export class IdentityAdminModule {}
