// Trust operations on the api host. S6: public.org_reviews (40 §14.3).
import { Module } from '@nestjs/common';
import { PublicOrgReviewsHandler } from './application/public-review-ops.js';

@Module({ providers: [PublicOrgReviewsHandler] })
export class TrustApiModule {}
