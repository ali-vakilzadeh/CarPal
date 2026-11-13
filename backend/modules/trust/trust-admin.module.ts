// Trust operations on the admin-api host (40 §23.4): Path 2 review approval,
// moving reviews to the approval path, disputes, the badge list and badge
// approval.
import { Module } from '@nestjs/common';
import {
  ApprovalViews,
  BadgeApproveHandler,
  BadgesListHandler,
  DisputeGetHandler,
  DisputeResolveHandler,
  DisputesQueueHandler,
  ReviewApprovalDecideHandler,
  ReviewApprovalGetHandler,
  ReviewApprovalsQueueHandler,
  ReviewMoveToApprovalPathHandler,
  StaffDisputeViews,
} from './application/admin-ops.js';
import { ReviewViews } from './application/common.js';

@Module({
  providers: [
    ReviewViews,
    ApprovalViews,
    StaffDisputeViews,
    ReviewApprovalsQueueHandler,
    ReviewApprovalGetHandler,
    ReviewApprovalDecideHandler,
    ReviewMoveToApprovalPathHandler,
    DisputesQueueHandler,
    DisputeGetHandler,
    DisputeResolveHandler,
    BadgesListHandler,
    BadgeApproveHandler,
  ],
})
export class TrustAdminModule {}
