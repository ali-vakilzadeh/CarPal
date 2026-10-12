// trust module (41 §2.1 M8; 40 §15). S6 delivers the public read side:
//   TrustModule      (global, every deployable) TrustRead: rating summaries and
//                    active public badges for profiles, search and ranking.
//   TrustApiModule   public.org_reviews on the api host (trust-api.module.ts).
// Reviews, invitations, approvals, disputes, trust scoring (W3) and badge
// rules arrive in S7.
import { Global, Module } from '@nestjs/common';
import { DbTrustRead } from './infrastructure/trust-read.js';
import { TrustRead } from './interface/trust.js';

@Global()
@Module({
  providers: [{ provide: TrustRead, useClass: DbTrustRead }],
  exports: [TrustRead],
})
export class TrustModule {}
