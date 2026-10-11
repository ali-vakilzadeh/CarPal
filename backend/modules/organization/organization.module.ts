// organization module (41 §2.1 M2). S2 provides only the OrganizationDirectory
// port the authorizer needs (type and status of the path organization);
// organizations, members, locations and profiles arrive in S4.
import { Global, Module } from '@nestjs/common';
import { OrganizationDirectory } from '#libs/authz/index.js';
import { DbOrganizationDirectory } from './infrastructure/organization-directory.js';

@Global()
@Module({
  providers: [{ provide: OrganizationDirectory, useClass: DbOrganizationDirectory }],
  exports: [OrganizationDirectory],
})
export class OrganizationModule {}
