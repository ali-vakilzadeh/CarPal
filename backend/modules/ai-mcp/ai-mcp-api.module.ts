// The §21 AI operations on the api host (40 §21.2-§21.4): Help Me triage,
// the asynchronous feature requests (202 Job, run by W9), insights,
// suggestions, approvals and the skill heatmap. Help Me drafts appointment
// requests through the appointment module's AppointmentDrafts.
import { Module } from '@nestjs/common';
import { AppointmentApiModule } from '#modules/appointment/appointment-api.module.js';
import { AiFeatureRequestHandler } from './application/features.js';
import {
  AiApprovalDecideHandler,
  AiApprovalsListHandler,
  AiInsightFeedbackHandler,
  AiInsightGetHandler,
  AiOwners,
  AiSkillHeatmapHandler,
  AiSuggestionDecideHandler,
  AiSuggestionsListHandler,
  AiSuggestionsMineHandler,
} from './application/insight-ops.js';
import {
  TriageCompleteHandler,
  TriageGetHandler,
  TriageReplyHandler,
  TriageService,
  TriageStartHandler,
} from './application/triage-ops.js';

@Module({
  imports: [AppointmentApiModule],
  providers: [
    TriageService,
    AiOwners,
    // §21.2 Help Me
    TriageStartHandler,
    TriageReplyHandler,
    TriageGetHandler,
    TriageCompleteHandler,
    // §21.3 feature requests and the skill heatmap
    AiFeatureRequestHandler,
    AiSkillHeatmapHandler,
    // §21.4 insights, suggestions, approvals
    AiInsightGetHandler,
    AiInsightFeedbackHandler,
    AiSuggestionsListHandler,
    AiSuggestionsMineHandler,
    AiSuggestionDecideHandler,
    AiApprovalsListHandler,
    AiApprovalDecideHandler,
  ],
})
export class AiMcpApiModule {}
