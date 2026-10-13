// Trust work on the worker deployable: W15 rules (41 §6.3). The W3 and W4
// consumers live in TrustModule and are subscribed by the consumer host.
import { Module } from '@nestjs/common';
import { ApprovalDeadlineRule, InvitationRule, TrustNightlyRule } from './application/review-workflow.js';

export { ApprovalDeadlineRule, InvitationRule, TrustNightlyRule };

@Module({ providers: [ApprovalDeadlineRule, InvitationRule, TrustNightlyRule] })
export class TrustWorkerModule {}
