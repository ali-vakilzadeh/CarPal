// Trust work on the worker deployable: W15 rules (41 §6.3). The W3 and W4
// consumers live in TrustModule and are subscribed by the consumer host.
import { Module } from '@nestjs/common';
import { ApprovalDeadlineRule, ApprovalReminderRule, InvitationRule, TrustNightlyRule } from './application/review-workflow.js';

export { ApprovalDeadlineRule, ApprovalReminderRule, InvitationRule, TrustNightlyRule };

@Module({ providers: [ApprovalDeadlineRule, ApprovalReminderRule, InvitationRule, TrustNightlyRule] })
export class TrustWorkerModule {}
