// Trust operations on the admin-api host (40 §23.4): Path 2 review approval,
// moving reviews to the approval path, disputes and their message threads
// (S20), the caller's own decisions (S18), the badge list and badge approval.
import { Module } from '@nestjs/common';
import {
  ApprovalViews,
  BadgeApproveHandler,
  BadgesListHandler,
  DisputeGetHandler,
  DisputeResolveHandler,
  DisputesQueueHandler,
  MyDecisionsListHandler,
  ReviewApprovalDecideHandler,
  ReviewApprovalGetHandler,
  ReviewApprovalsQueueHandler,
  ReviewMoveToApprovalPathHandler,
  StaffDisputeViews,
} from './application/admin-ops.js';
import { ReviewViews } from './application/common.js';
import { AdminDisputeMessagePostHandler, AdminDisputeMessagesListHandler, DisputeParties } from './application/dispute-messages.js';

@Module({
  providers: [
    ReviewViews,
    ApprovalViews,
    StaffDisputeViews,
    DisputeParties,
    ReviewApprovalsQueueHandler,
    ReviewApprovalGetHandler,
    ReviewApprovalDecideHandler,
    ReviewMoveToApprovalPathHandler,
    DisputesQueueHandler,
    DisputeGetHandler,
    DisputeResolveHandler,
    AdminDisputeMessagesListHandler,
    AdminDisputeMessagePostHandler,
    MyDecisionsListHandler,
    BadgesListHandler,
    BadgeApproveHandler,
  ],
})
export class TrustAdminModule {}
