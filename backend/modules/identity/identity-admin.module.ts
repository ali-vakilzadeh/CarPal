// Identity operations on the admin-api host (40 §23.2 users and the staff
// directory, the staff member's own keys and recovery codes, §23.5 data subject requests and policy texts). Needs IdentityModule, AdminModule, BillingModule,
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
import {
  AdminPoliciesListHandler,
  AdminPolicyVersionCreateHandler,
  AdminPolicyVersionGetHandler,
  AdminPolicyVersionPublishHandler,
  AdminPolicyVersionUpdateHandler,
  PolicyStaffViews,
} from './application/policy-ops.js';
import { DsrViews } from './application/privacy-ops.js';
import { AdminStaffDisableHandler, AdminStaffEnableHandler, AdminStaffListHandler } from './application/staff-ops.js';
import {
  AdminStaffPasskeyRegisterHandler,
  AdminStaffPasskeyRegisterOptionsHandler,
  AdminStaffPasskeyRemoveHandler,
  AdminStaffPasskeysListHandler,
  AdminStaffRecoveryCodesRegenerateHandler,
} from './application/staff-security.js';
import { WebAuthnService } from './application/webauthn.js';

@Module({
  providers: [
    StaffUserViews,
    DsrViews,
    AdminStaffMeHandler,
    AdminStaffListHandler,
    AdminStaffDisableHandler,
    AdminStaffEnableHandler,
    WebAuthnService,
    AdminStaffPasskeysListHandler,
    AdminStaffPasskeyRegisterOptionsHandler,
    AdminStaffPasskeyRegisterHandler,
    AdminStaffPasskeyRemoveHandler,
    AdminStaffRecoveryCodesRegenerateHandler,
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
    PolicyStaffViews,
    AdminPoliciesListHandler,
    AdminPolicyVersionGetHandler,
    AdminPolicyVersionCreateHandler,
    AdminPolicyVersionUpdateHandler,
    AdminPolicyVersionPublishHandler,
  ],
})
export class IdentityAdminModule {}
