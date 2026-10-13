// Trust operations on the api host: §15 reviews, invitations, approvals,
// responses, disputes, badges and trust signals, plus public.org_reviews
// (40 §14.3). Needs TrustModule, AppointmentModule, OrganizationModule,
// IdentityModule, InventoryModule, VehicleModule, MediaModule, TaxonomyModule
// and NotificationMessagingModule (global) in the same application.
import { Module } from '@nestjs/common';
import {
  BadgesListHandler,
  OrgReviewViews,
  ReviewApprovalsAnswerHandler,
  ReviewApprovalsListHandler,
  ReviewResponsesCreateHandler,
  ReviewResponsesDeleteHandler,
  ReviewResponsesPublishHandler,
  ReviewResponsesUpdateHandler,
  ReviewsOrgGetHandler,
  ReviewsOrgListHandler,
  TrustSignalsListHandler,
} from './application/business-ops.js';
import { ReviewViews, Subjects } from './application/common.js';
import { DisputesCreateHandler, DisputesGetHandler, DisputesMineListHandler, DisputesWithdrawHandler } from './application/dispute-ops.js';
import {
  InvitationViews,
  ReviewInvitationsCancelHandler,
  ReviewInvitationsMineListHandler,
  ReviewInvitationsOpenHandler,
  ReviewInvitationsOrgListHandler,
  ReviewInvitationsSendHandler,
  ReviewInvitationsVerifyHandler,
} from './application/invitation-ops.js';
import { PublicOrgReviewsHandler } from './application/public-review-ops.js';
import {
  ReviewPaths,
  ReviewsCreateHandler,
  ReviewsEligibilityHandler,
  ReviewsEvidenceAddHandler,
  ReviewsMineGetHandler,
  ReviewsMineListHandler,
  ReviewsMineUpdateHandler,
  ReviewsMineWithdrawHandler,
} from './application/review-ops.js';

@Module({
  providers: [
    ReviewViews,
    OrgReviewViews,
    Subjects,
    ReviewPaths,
    InvitationViews,
    PublicOrgReviewsHandler,
    // author (§15.2)
    ReviewsEligibilityHandler,
    ReviewsCreateHandler,
    ReviewsMineListHandler,
    ReviewsMineGetHandler,
    ReviewsMineUpdateHandler,
    ReviewsMineWithdrawHandler,
    ReviewsEvidenceAddHandler,
    ReviewInvitationsMineListHandler,
    ReviewInvitationsOpenHandler,
    ReviewInvitationsVerifyHandler,
    // business (§15.3)
    ReviewInvitationsSendHandler,
    ReviewInvitationsOrgListHandler,
    ReviewInvitationsCancelHandler,
    ReviewsOrgListHandler,
    ReviewsOrgGetHandler,
    ReviewResponsesCreateHandler,
    ReviewResponsesUpdateHandler,
    ReviewResponsesPublishHandler,
    ReviewResponsesDeleteHandler,
    ReviewApprovalsListHandler,
    ReviewApprovalsAnswerHandler,
    DisputesCreateHandler,
    DisputesMineListHandler,
    DisputesGetHandler,
    DisputesWithdrawHandler,
    BadgesListHandler,
    TrustSignalsListHandler,
  ],
})
export class TrustApiModule {}
