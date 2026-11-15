// Organization operations on the admin-api host (40 §23.2): search and read,
// status, merge (4EYES, a job after approval) and its preview (S22), verification queue, assignment and decisions (with
// requests for more information, S19), location corrections, profile
// corrections and the profile history (S19); the capabilities and badges, portfolio and members tabs (S23).
import { Module } from '@nestjs/common';
import {
  AdminLocationCorrectHandler,
  AdminOrgCorrectHandler,
  AdminOrgGetHandler,
  AdminOrgHistoryHandler,
  AdminOrgsSearchHandler,
  AdminOrgStatusHandler,
  AdminVerificationAssignHandler,
  AdminVerificationDecideHandler,
  AdminVerificationsQueueHandler,
  StaffOrgSearchRows,
  StaffOrgViews,
  StaffVerificationItems,
} from './application/admin-ops.js';
import { LocationChecker } from './application/location-ops.js';
import { AdminOrgMergeHandler, AdminOrgMergePreviewHandler } from './application/merge.js';
import { PortfolioRules } from './application/provider-work-ops.js';
import { AdminOrgCapabilitiesHandler, AdminOrgMembersHandler, AdminOrgPortfolioHandler } from './application/staff-tabs.js';

@Module({
  providers: [
    LocationChecker,
    StaffOrgSearchRows,
    StaffOrgViews,
    StaffVerificationItems,
    AdminOrgsSearchHandler,
    AdminOrgGetHandler,
    AdminOrgStatusHandler,
    AdminOrgMergeHandler,
    AdminOrgMergePreviewHandler,
    AdminVerificationsQueueHandler,
    AdminVerificationAssignHandler,
    AdminVerificationDecideHandler,
    AdminLocationCorrectHandler,
    AdminOrgCorrectHandler,
    AdminOrgHistoryHandler,
    // Backend S23 (BR-16): A-ORG-02 Capabilities & badges, Portfolio and Members.
    PortfolioRules,
    AdminOrgCapabilitiesHandler,
    AdminOrgPortfolioHandler,
    AdminOrgMembersHandler,
  ],
})
export class OrganizationAdminModule {}
