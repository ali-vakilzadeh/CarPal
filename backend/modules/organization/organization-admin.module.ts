// Organization operations on the admin-api host (40 §23.2): search and read,
// status, merge (4EYES), verification queue, assignment and decisions (with
// requests for more information, S19), location corrections, profile
// corrections and the profile history (S19).
import { Module } from '@nestjs/common';
import {
  AdminLocationCorrectHandler,
  AdminOrgCorrectHandler,
  AdminOrgGetHandler,
  AdminOrgHistoryHandler,
  AdminOrgMergeHandler,
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
    AdminVerificationsQueueHandler,
    AdminVerificationAssignHandler,
    AdminVerificationDecideHandler,
    AdminLocationCorrectHandler,
    AdminOrgCorrectHandler,
    AdminOrgHistoryHandler,
  ],
})
export class OrganizationAdminModule {}
