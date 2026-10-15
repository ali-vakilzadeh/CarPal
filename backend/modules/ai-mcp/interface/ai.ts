// Public interface of the ai-mcp module (41 §4.2 interface/; 40 §21,
// SEC-AI-3). Other modules never read ai_mcp.* tables: they resolve the AI
// references their own records carry (ai_caption_insight_id,
// ai_draft_insight_id, redaction_insight_id, triage_session_id) through
// AiReferences in the caller's transaction (RLS: the insight's organization
// or owner), and owning modules register how an accepted AiSuggestion is
// applied (ai.suggestion_decide applies the change "through the owning
// module's normal validation, as if the user had typed it").
import type { InsightType } from '#libs/contract/generated/enums.js';
import type { Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** An AI insight the caller may cite in a human operation (not internal, not rejected, not expired). */
export interface UsableInsight {
  id: string;
  insightType: InsightType;
  subject: { type: string; id: string };
  organizationId: string | null;
  ownerUserId: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  humanApprovalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
}

/** A Help Me session as other modules see it (appointments, issues, pre-visit reports). */
export interface TriageFacts {
  id: string;
  vehicleId: string;
  issueId: string | null;
  status: 'in_progress' | 'completed' | 'abandoned' | 'escalated_safety';
  urgency: Urgency | null;
  safetyCritical: boolean;
  symptomNodeIds: string[];
  likelySystemNodeIds: string[];
  recommendedServiceNodeId: string | null;
  /** The triage_summary insight (null until the session completed with AI available). */
  resultInsightId: string | null;
  /** Its summary text, in the session locale. */
  summary: string | null;
}

export abstract class AiReferences {
  /**
   * An insight of the caller's organization or of the caller (RLS), of one of
   * `types`, optionally about `subject`; null when unknown, internal,
   * rejected, expired or of another type/subject (callers answer 422
   * REFERENCE_NOT_FOUND at their pointer).
   */
  abstract usable(
    scope: TxScope,
    insightId: string,
    o: { types: readonly InsightType[]; subject?: { type: string; id: string } },
  ): Promise<UsableInsight | null>;
  /**
   * The human operation that used the insight approves it (SEC-AI-3): the
   * domain publish operation, or the user's own submit. Idempotent.
   */
  abstract approveUse(scope: TxScope, insightId: string): Promise<void>;
  /** True while the insight's ApprovalRequest (a staff member's draft, 53 §14.2) is pending or was rejected. */
  abstract awaitingApproval(scope: TxScope, insightId: string): Promise<boolean>;
  /** A Help Me session of the caller (self only), else null. */
  abstract triage(scope: TxScope, sessionId: string): Promise<TriageFacts | null>;
  /** An active internal MCP client of the registry (consents may name one as grantee, 40 ConsentGrant.granted_to). */
  abstract activeMcpClient(clientId: string): Promise<boolean>;
  /** Links the session to the appointment drafted or sent from it (TriageSession.appointment_draft_id). */
  abstract linkAppointment(scope: TxScope, sessionId: string, appointmentId: string): Promise<void>;
}

/** An AiSuggestion being accepted. */
export interface SuggestionToApply {
  id: string;
  insightId: string;
  targetType: string;
  targetId: string;
  action: 'add' | 'update' | 'remove' | 'publish_draft' | 'confirm' | 'review';
  /** proposed_payload, or the caller's edited_payload (accept_with_edits). */
  payload: Record<string, unknown> | null;
  organizationId: string | null;
  ownerUserId: string | null;
  /** Who decides (the authenticated user). */
  actorUserId: string;
}

/**
 * Applies an accepted suggestion with the owning module's rules in the
 * caller's transaction (RLS of the deciding user / organization). Throws the
 * module's own ApiError (422 VALIDATION_FAILED with pointers under
 * /edited_payload, 404, 409) when the change is not possible.
 */
export type SuggestionApplier = (scope: TxScope, s: SuggestionToApply) => Promise<void>;

export class SuggestionAppliers {
  readonly #appliers = new Map<string, SuggestionApplier>();

  /** One applier per target entity type (vehicle, maintenance_reminder, inventory_item …). */
  register(targetType: string, applier: SuggestionApplier): void {
    if (this.#appliers.has(targetType)) throw new Error(`suggestion applier ${targetType} registered twice`);
    this.#appliers.set(targetType, applier);
  }

  get(targetType: string): SuggestionApplier | undefined {
    return this.#appliers.get(targetType);
  }
}

/** Who an AI feature runs for: the caller (and organization) of the §21 operation, or the job's owner in W9. */
export interface AiPrincipal {
  userId: string;
  /** The organization of the operation (provider, vendor or fleet), or null for personal data. */
  orgId: string | null;
  role: string | null;
}

/**
 * Context packages (53 §11) come from the module that owns the data, read in
 * the caller's transaction and RLS context (SEC-AI-4: the organization's own
 * data and public data only). A source answers null when the target is not
 * the caller's (the facade answers 404 / 422) and otherwise a minimized
 * package: ids, enums, counts and short texts, never contact data.
 */
export type AiSourceKey =
  | 'vehicle.profile'
  | 'vehicle.history'
  | 'fleet.vehicles'
  | 'provider.profile_facts'
  | 'provider.portfolio_item'
  | 'provider.appointment'
  | 'review.for_response'
  | 'review.period'
  | 'vendor.items'
  | 'vendor.item'
  | 'vendor.catalog'
  | 'search.part_demand'
  | 'review.pattern_facts';

export type AiSource = (scope: TxScope, who: AiPrincipal, args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

/**
 * Where AI output becomes a pending domain record that a human decides with
 * the owning module's own operation (provider.gated_decide, fitment.decide,
 * media.redaction_decide): never active, public or operational by itself
 * (SEC-AI-3). Returns the number of records written.
 */
export type AiSinkKey = 'provider.capability_suggestions' | 'vendor.fitment_suggestions' | 'media.redaction_suggestions';

export type AiSink = (
  scope: TxScope,
  who: AiPrincipal,
  insightId: string,
  payload: Record<string, unknown>,
  subject: { type: string; id: string },
) => Promise<number>;

export class AiContextSources {
  readonly #sources = new Map<AiSourceKey, AiSource>();
  readonly #sinks = new Map<AiSinkKey, AiSink>();

  register(key: AiSourceKey, source: AiSource): void {
    if (this.#sources.has(key)) throw new Error(`AI context source ${key} registered twice`);
    this.#sources.set(key, source);
  }

  registerSink(key: AiSinkKey, sink: AiSink): void {
    if (this.#sinks.has(key)) throw new Error(`AI output sink ${key} registered twice`);
    this.#sinks.set(key, sink);
  }

  source(key: AiSourceKey): AiSource {
    const s = this.#sources.get(key);
    if (!s) throw new Error(`AI context source ${key} not registered`);
    return s;
  }

  sink(key: AiSinkKey): AiSink {
    const s = this.#sinks.get(key);
    if (!s) throw new Error(`AI output sink ${key} not registered`);
    return s;
  }
}
