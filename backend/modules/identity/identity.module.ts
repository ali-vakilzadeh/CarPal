// identity module (41 §2.1 M1). S2 provides only the MembershipDirectory port
// the authorizer needs; accounts, sessions, consent and DSR arrive in S3.
// Global so the platform's Authorizer (a global provider) can inject the port.
import { Global, Module } from '@nestjs/common';
import { MembershipDirectory } from '#libs/authz/index.js';
import { DbMembershipDirectory } from './infrastructure/membership-directory.js';

@Global()
@Module({
  providers: [{ provide: MembershipDirectory, useClass: DbMembershipDirectory }],
  exports: [MembershipDirectory],
})
export class IdentityModule {}
