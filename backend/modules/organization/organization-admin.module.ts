// Organization operations on the admin-api host (40 §23.2): search and read,
// status, merge (4EYES), verification queue and decisions, location
// corrections.
import { Module } from '@nestjs/common';
import {
  AdminLocationCorrectHandler,
  AdminOrgGetHandler,
  AdminOrgMergeHandler,
  AdminOrgsSearchHandler,
  AdminOrgStatusHandler,
  AdminVerificationDecideHandler,
  AdminVerificationsQueueHandler,
  StaffOrgViews,
} from './application/admin-ops.js';
import { LocationChecker } from './application/location-ops.js';

@Module({
  providers: [
    LocationChecker,
    StaffOrgViews,
    AdminOrgsSearchHandler,
    AdminOrgGetHandler,
    AdminOrgStatusHandler,
    AdminOrgMergeHandler,
    AdminVerificationsQueueHandler,
    AdminVerificationDecideHandler,
    AdminLocationCorrectHandler,
  ],
})
export class OrganizationAdminModule {}
