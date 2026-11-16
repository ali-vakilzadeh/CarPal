// Public interface of the admin module (41 §2.1 M15; 40 §23, SEC-ADM). The
// admin plane's cross-module mechanics live here as ports and registries
// (GD-15), so owning modules keep their own tables:
//   FourEyes / FourEyesExecutors  4EYES operations (SEC-ADM-6): an owning
//                       module's handler files a pending change, and
//                       registers the executor that applies it when a second
//                       staff member approves (admin.four_eyes_decide).
//   PurposeQueues       CarPal-Access-Purpose binding (SEC-ADM-5): each kind
//                       (case, dispute, dsr, verification, approval) is
//                       resolved by the module that owns the queue item,
//                       which also names the item's subjects (backend S14).
//   PurposeBindings     the record each PURP operation reads or changes, so
//                       the purpose is admitted only for a subject of its
//                       item (PurposeSubjects reads the subjects in handlers).
//   ModerationTargets   content owners plug their records into reports and
//                       moderation cases (existence, snapshot, hide/remove/
//                       restore/approve, owning organization).
//   ModerationLog       append-only moderation actions written by any module
//                       (52 ModerationAction) and the trust inputs they carry.
import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { auditPiiRead } from '#libs/audit/index.js';
import type { AccessPurpose, PurposeKind } from '#libs/authz/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';

export type StaffRole = 'platform_admin' | 'platform_moderator' | 'platform_support' | 'platform_community_reviewer';

/** The staff caller of an admin-plane operation (STF already checked by the authorizer). */
export interface Staff {
  userId: string;
  roles: string[];
  /** CarPal-Access-Purpose of PURP operations ("case:<id>" …), else null. */
  purpose: string | null;
  /** The purpose item's subject the request's record was bound to ("user:<id>" …), named in pii.read entries (S14). */
  bound: string | null;
}

export function staffOf(ctx: OperationContext): Staff {
  if (ctx.principal.kind !== 'staff') throw new ApiError('NOT_FOUND');
  return {
    userId: ctx.principal.userId,
    roles: ctx.access.platformRoles,
    purpose: ctx.access.purpose?.value ?? null,
    bound: ctx.access.purpose?.bound ?? null,
  };
}

/**
 * DI-09: DELETE takes no body (TR-6), so RSN operations answered by DELETE
 * (admin.platform_role_revoke, admin.synonym_delete) carry their reason in the
 * CarPal-Reason header: 3–500 characters on one line, percent-encoded when
 * it is not ASCII. Missing or invalid → 422 VALIDATION_FAILED at /reason.
 */
export function headerReasonOf(ctx: OperationContext): string {
  const raw = ctx.headers['carpal-reason'];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  let reason = v;
  try {
    reason = decodeURIComponent(v);
  } catch {
    // not percent-encoded: plain ASCII text
  }
  const n = [...reason].length;
  if (n < 3 || n > 500 || reason.includes('\n') || reason.includes('\r'))
    throw ApiError.validation([{ pointer: '/reason', code: reason ? 'pattern' : 'required' }]);
  return reason;
}

/**
 * SEC-LOG-4 / SEC-ADM-5: a staff read of private data writes a pii.read audit
 * entry with the access purpose and the purpose item's subject the record was
 * bound to (the pipeline refuses a staff PII response without an audit entry).
 * `bound` overrides the request's binding (a search names each subject found).
 */
export async function auditStaffRead(
  scope: TxScope,
  staff: Staff,
  entityType: string,
  entityId: string,
  fieldsGroup: string,
  bound: string | null = staff.bound,
): Promise<void> {
  if (!staff.purpose) throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Access-Purpose required' });
  const group = bound ? `${fieldsGroup}; subject ${bound}` : fieldsGroup;
  await auditPiiRead(scope, { entityType, entityId, accessPurpose: staff.purpose, fieldsGroup: group });
}

/** 40 §23.1 PendingChange. */
export interface PendingChangeView {
  change_id: string;
  op_id: string;
  summary: string;
  requested_by_display: string;
  requested_at: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expires_at: string;
  /** Contract 1.4.0 (admin console BR-21): the decision, once decided. */
  decided_by_display: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  /** Contract 1.4.0: the background job an approved ASYNC change started (admin.job_get). */
  job_id: string | null;
}

export interface PendingChangeRequest {
  /** The 4EYES operation, e.g. "admin.org_merge". */
  opId: string;
  targetType: string;
  targetId: string;
  /** The validated request body (plus path parameters), replayed by the executor on approval. */
  payload: Record<string, unknown>;
  summary: string;
  reason: string;
  /** Role a second approver needs (52 PendingAdminChange.required_role). */
  requiredRole: 'platform_admin' | 'platform_moderator';
}

/** A pending change being approved: executors apply it in the approver's transaction (staff context). */
export interface ApprovedChange {
  id: string;
  opId: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  decisionReason: string;
  requestId: string;
}

/** What an executor may report: the background job an ASYNC change started (stored as PendingChange.job_id). */
export type FourEyesOutcome = { jobId: string } | void;
export type FourEyesExecutor = (scope: TxScope, change: ApprovedChange) => Promise<FourEyesOutcome>;

export abstract class FourEyes {
  /**
   * Files a pending change (status pending, expires after 72 h) with its
   * audit entry in the caller's transaction; returns the 202 body. A second
   * pending change for the same operation and target is 409 DUPLICATE.
   */
  abstract request(scope: TxScope, staffUserId: string, r: PendingChangeRequest, locale: string): Promise<PendingChangeView>;

  /**
   * Rejects every pending change a staff member requested, in the caller's transaction, with `reason` as the decision
   * reason and `decidedBy` as the decider (backend S16a, DQ-11: disabling a member ends their requests). Returns the
   * number rejected.
   */
  abstract rejectRequestsOf(scope: TxScope, requesterUserId: string, decidedBy: string, reason: string): Promise<number>;

  /**
   * The live pending change of `opId` for each of `targetIds` (pending and not expired), by target id (backend S25a,
   * DQ-22: a dispute whose resolution awaits an administrator's approval).
   */
  abstract pendingFor(scope: TxScope, opId: string, targetIds: string[]): Promise<Map<string, { changeId: string; expiresAt: Date }>>;
}

/** Executors of approved changes by operation id (registered in onModuleInit; an unknown op cannot be approved). */
export class FourEyesExecutors {
  readonly #executors = new Map<string, FourEyesExecutor>();

  register(opId: string, executor: FourEyesExecutor): void {
    if (this.#executors.has(opId)) throw new Error(`four-eyes executor ${opId} registered twice`);
    this.#executors.set(opId, executor);
  }

  get(opId: string): FourEyesExecutor | undefined {
    return this.#executors.get(opId);
  }
}

/**
 * Is the purpose item open in the staff member's queue? (SEC-ADM-5: assigned
 * to them or unassigned and open). Runs in a read-only staff transaction.
 */
export type PurposeResolver = (scope: TxScope, staffUserId: string, id: string, opId: string) => Promise<boolean>;

/**
 * A record a purpose can be about (backend S14, BR-09): `type` is a 52 entity
 * name as used by moderation targets and media attachments ('user',
 * 'organization', 'review', 'media_asset' …) or a purpose kind for the item
 * itself ('case', 'dispute', 'dsr', 'verification', 'approval').
 */
export interface SubjectRef {
  type: string;
  id: string;
}

export const subjectKey = (s: SubjectRef): string => `${s.type}:${s.id}`;

/**
 * The records a purpose item is about (its subjects), besides the item itself,
 * which is always a subject. Runs in the same read-only staff transaction as
 * the queue check. Example: a case about a post names the post, its author,
 * its organization and the reporters.
 */
export type SubjectResolver = (scope: TxScope, id: string) => Promise<SubjectRef[]>;

export interface PurposeQueue {
  open: PurposeResolver;
  subjects: SubjectResolver;
}

export class PurposeQueues {
  readonly #queues = new Map<PurposeKind, PurposeQueue>();

  register(kind: PurposeKind, queue: PurposeQueue): void {
    if (this.#queues.has(kind)) throw new Error(`purpose queue ${kind} registered twice`);
    this.#queues.set(kind, queue);
  }

  get(kind: PurposeKind): PurposeQueue | undefined {
    return this.#queues.get(kind);
  }
}

/**
 * The record a PURP operation reads or changes, from its path parameters (and a
 * lookup where the record is a file): any of the returned refs that is a subject
 * of the purpose item admits the purpose. An empty list (the record does not
 * exist) is refused like an unrelated record. `'scoped'`: the operation limits
 * its own results to the item's subjects (admin.users_search, PurposeSubjects).
 */
export type RecordBinding = (scope: TxScope, params: Record<string, string>) => Promise<SubjectRef[] | 'scoped'>;

/** One binding per PURP operation; an operation without one refuses every purpose (fail closed). */
export class PurposeBindings {
  readonly #bindings = new Map<string, RecordBinding>();

  register(opId: string, binding: RecordBinding): void {
    if (this.#bindings.has(opId)) throw new Error(`purpose binding ${opId} registered twice`);
    this.#bindings.set(opId, binding);
  }

  get(opId: string): RecordBinding | undefined {
    return this.#bindings.get(opId);
  }

  opIds(): string[] {
    return [...this.#bindings.keys()];
  }
}

/** The binding of an operation whose record is a path parameter, e.g. pathRecord('user', 'user_id'). */
export const pathRecord =
  (type: string, param: string): RecordBinding =>
  async (_scope, params) =>
    params[param] ? [{ type, id: params[param] }] : [];

/** The subjects of the request's purpose item, for handlers that scope their results or check a body reference. */
export abstract class PurposeSubjects {
  /** Every subject of the item, the item itself first. */
  abstract of(scope: TxScope, purpose: AccessPurpose): Promise<SubjectRef[]>;
}

/** Content and account types a report or moderation case can target (40 ReportTargetType + badge). */
export type ModerationTargetType =
  | 'review'
  | 'review_response'
  | 'post'
  | 'comment'
  | 'question'
  | 'answer'
  | 'portfolio_item'
  | 'media_asset'
  | 'inventory_item'
  | 'inventory_fitment'
  | 'organization'
  | 'organization_location'
  | 'user'
  | 'ai_output'
  | 'badge';

/** Docs/23 A-CON-01: cases about these reasons are at least high (backend S18, BR-32); a database trigger enforces it too. */
export const SEVERITY_FLOOR_REASONS: readonly string[] = ['unsafe_advice', 'non_consensual_media', 'privacy'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** The severity a case opens with: the floor raises low and medium to high for the floor reasons. */
export function caseSeverity(reason: string, severity: string): string {
  return SEVERITY_FLOOR_REASONS.includes(reason) && SEVERITIES.indexOf(severity) < SEVERITIES.indexOf('high') ? 'high' : severity;
}

/** CaseTargetSummary.excerpt (40 §23.1): one line, at most 120 characters, null when there is no text. */
export function excerpt(text: string | null | undefined, max = 120): string | null {
  const line = (text ?? '').replace(/\s+/gu, ' ').trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length <= max
    ? line
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/** Content actions an owning module applies to its own record (52 ModerationAction.action_type subset). */
export type ContentAction = 'approve' | 'hide' | 'remove' | 'restore' | 'request_changes';

/**
 * Record-specific actions with parameters (backend S20, BR-15): reduce_weight and edit_request on reviews,
 * downgrade_fitment on fitment rows; apply_redaction on images (backend S22: boxes, the media worker writes the
 * redacted copy). The owning module validates the parameters and changes its record.
 */
export type TargetAction = 'reduce_weight' | 'edit_request' | 'downgrade_fitment' | 'apply_redaction';

/** What a TargetAction needs: the validated case-action parameters and who acts under which case. */
export interface TargetActionInput {
  staffUserId: string;
  caseId: string;
  reason: string;
  params: {
    weight_factor?: string;
    edit_spans?: { field: 'title' | 'body'; start: number; end: number }[];
    edit_message?: string;
    fitment_confidence?: 'likely' | 'uncertain';
    /** apply_redaction: boxes relative to the image (0..1), at most 30. */
    redaction_regions?: { x: string | number; y: string | number; w: string | number; h: string | number }[];
  };
}

/**
 * The outcome of a TargetAction: `params` are recorded with the moderation action (the previous value, for the
 * log), or a refusal: `invalid` names a parameter pointer (422), `transition` a state that does not allow it (409).
 */
export type TargetActionResult =
  { ok: true; params: Record<string, unknown> } | { ok: false; invalid: FieldError } | { ok: false; transition: string };

/** 40 CaseTargetSummary of a record (backend S18, BR-27). */
export interface TargetSummary {
  excerpt: string | null;
  rating: number | null;
}

/** The author of a record as its owning module knows it (40 ContentAuthor; backend S18, BR-33). */
export interface TargetAuthor {
  userId: string;
  /** The organization the record was written for (a post, an answer given as an organization, a review answer), or null. */
  organizationId: string | null;
  /** The author's records of the same kind that are live, and that are hidden, removed or rejected. */
  published: number;
  removed: number;
}

/** A comment or answer around a case target (40 CaseContextItem), as the owning module reads it. */
export interface ContextRecord {
  type: 'comment' | 'answer';
  id: string;
  body: string;
  status: string;
  moderationStatus: string;
  createdAt: Date;
  authorUserId: string;
  organizationId: string | null;
  isTarget: boolean;
}

/** 40 CaseContext before the admin module resolves authors and the parent's snapshot. */
export interface TargetContext {
  /** The record a comment is on, or the question of an answer; null when the target is that record itself. */
  parent: SubjectRef | null;
  items: ContextRecord[];
  total: number;
}

export interface ModerationTargetHandler {
  /** Does the record exist (not deleted)? Runs in the system context (reports from any user). */
  exists(scope: TxScope, id: string): Promise<boolean>;
  /**
   * 40 case_get target_snapshot: the fields of the record's TargetSnapshot type (backend S18) with `available: true`,
   * never contact data, secrets or internal scores. Null when gone. The admin module adds `author` (authorOf).
   */
  snapshot(scope: TxScope, id: string, locale: string): Promise<Record<string, unknown> | null>;
  /** CaseTargetSummary of each existing record among `ids` (cases_list); records that are gone are left out. */
  summaries(scope: TxScope, ids: readonly string[], locale: string): Promise<Map<string, TargetSummary>>;
  /** The author block of a record whose snapshot type has `author` (content and files); null when it has none. */
  authorOf?(scope: TxScope, id: string): Promise<TargetAuthor | null>;
  /** The comments or answers around a record (admin.case_context): community content only. */
  context?(scope: TxScope, id: string, limit: number): Promise<TargetContext | null>;
  /** The organization the content belongs to (trust penalties, notifications), or null. */
  subjectOrganization?(scope: TxScope, id: string): Promise<string | null>;
  /** The user who wrote or owns the content (warnings, suspensions), or null. */
  author?(scope: TxScope, id: string): Promise<string | null>;
  /**
   * Applies a content action in the staff transaction. Returns false when the
   * action does not apply to the record's current state (409 INVALID_TRANSITION).
   */
  apply?(scope: TxScope, id: string, action: ContentAction): Promise<boolean>;
  /** Applies a record-specific action (backend S20) in the staff transaction; absent = the action does not apply. */
  act?(scope: TxScope, id: string, action: TargetAction, input: TargetActionInput): Promise<TargetActionResult>;
  /**
   * Records held for a moderator (pending moderation, pending review), oldest
   * first, at most `limit`: the intake rule opens a system_rule case for each
   * one without an open case.
   */
  pending?(scope: TxScope, limit: number): Promise<string[]>;
}

export class ModerationTargets {
  readonly #handlers = new Map<ModerationTargetType, ModerationTargetHandler>();

  register(type: ModerationTargetType, handler: ModerationTargetHandler): void {
    if (this.#handlers.has(type)) throw new Error(`moderation target ${type} registered twice`);
    this.#handlers.set(type, handler);
  }

  get(type: string): ModerationTargetHandler | undefined {
    return this.#handlers.get(type as ModerationTargetType);
  }
}

export interface ModerationActionRecord {
  caseId?: string | null;
  targetType: string;
  targetId: string;
  actionType: string;
  reason: string;
  params?: Record<string, unknown> | null;
  actorUserId: string;
}

/** A trust penalty carried by moderation actions (54 §3.3), read by the W3 trust scorer. */
export interface TrustPenaltyInput {
  actionId: string;
  kind: 'admin_trust_penalty' | 'content_violation' | 'fake_review';
  points: number;
  createdAt: Date;
}

export abstract class ModerationLog {
  /** Appends a ModerationAction (52: append-only, reason 3–500 chars); returns its id. */
  abstract record(scope: TxScope, a: ModerationActionRecord): Promise<string>;
  /**
   * Penalty inputs of an organization from moderation actions of the last 12
   * months (54 §3.3): apply_trust_penalty (admin points), confirmed content
   * violations (remove/hide on its content, −20 once) and fake-review findings.
   */
  abstract penalties(scope: TxScope, orgId: string, since: Date): Promise<TrustPenaltyInput[]>;
  /** One moderation action (dispute targets: appeals, the actor who made the disputed decision, the S20 snapshot). */
  abstract get(scope: TxScope, id: string): Promise<LoggedAction | null>;
  /**
   * The parties a moderation action affected (definer admin.moderation_action_affects):
   * appeals by users and organizations, in their own RLS context.
   */
  abstract affects(scope: TxScope, actionId: string): Promise<{ userId: string | null; organizationId: string | null } | null>;
  /** Reports filed against a record (staff views: StaffUserView.counts.reports_against). */
  abstract reportsAgainst(scope: TxScope, targetType: string, targetId: string, reason?: string): Promise<number>;
  /** Open moderation cases about a record (StaffOrgView.open_cases). */
  abstract openCases(scope: TxScope, targetType: string, targetId: string): Promise<number>;
  /** The records among `ids` with an open moderation case about them (admin.orgs_search has_open_cases, backend S19). */
  abstract withOpenCases(scope: TxScope, targetType: string, ids: readonly string[]): Promise<Set<string>>;
  /**
   * The records among `ids` with an open report of `reason` (status open, or triaged into a case not yet closed),
   * as "type:id" keys (admin.orgs_search location_issue: wrong-location reports, backend S19).
   */
  abstract withOpenReports(scope: TxScope, targets: readonly SubjectRef[], reason: string): Promise<Set<string>>;
  /**
   * One staff member's actions of the given types since `since`, newest first, at most `limit` (backend S18,
   * admin.my_decisions_list). Actions recorded by a dispute resolution (params.dispute_id) are left out.
   */
  abstract byActor(scope: TxScope, actorUserId: string, actionTypes: readonly string[], since: Date, limit: number): Promise<ActorAction[]>;
}

/** One logged moderation action (ModerationLog.get). */
export interface LoggedAction {
  targetType: string;
  targetId: string;
  actionType: string;
  actorUserId: string;
  params: Record<string, unknown>;
  reason: string;
  caseId: string | null;
  createdAt: Date;
}

/** A moderation action of one staff member (ModerationLog.byActor). */
export interface ActorAction {
  id: string;
  targetType: string;
  targetId: string;
  actionType: string;
  params: Record<string, unknown>;
  createdAt: Date;
}

/** An automated flag (W11 fraud detection, AI moderation hints): it only opens a case, humans decide (52 ModerationCase). */
export interface AutomatedFlag {
  targetType: ModerationTargetType;
  targetId: string;
  reason: 'fake' | 'spam' | 'other';
  severity: 'low' | 'medium' | 'high';
  /** 0–100 risk score of the flag. */
  riskScore: number | null;
  /** The internal fraud_flag insight behind an ai_flag case; null for a plain system rule. */
  insightId: string | null;
}

export abstract class ModerationIntake {
  /**
   * Opens an ai_flag (insight) or system_rule case for the target unless an
   * open case exists; system context. Returns the case id, or null when one
   * was already open.
   */
  abstract open(scope: TxScope, f: AutomatedFlag): Promise<string | null>;
}

export type { AccessPurpose, PurposeKind };

/** An active DataRetentionPolicy (52) handed to the module that owns the entity type. */
export interface RetentionPolicyRecord {
  id: string;
  entityType: string;
  appliesToStatus: string | null;
  retentionDays: number;
  action: 'delete' | 'anonymize' | 'archive';
}

/**
 * Applies one retention policy to the owning module's records older than
 * retention_days (system context, worker); returns the number of records
 * deleted or anonymized. Archive policies keep rows (no handler needed).
 */
export type RetentionHandler = (scope: TxScope, policy: RetentionPolicyRecord) => Promise<number>;

/** What a retention handler would delete or anonymize now (admin.retention_dry_run, backend S21), per record status where the entity has one. */
export interface RetentionCount {
  affected: number;
  byStatus?: { status: string; count: number }[];
}

/**
 * Counts the records `RetentionHandler` would change for the policy, with the handler's own conditions, without
 * changing anything. Runs in the caller's read-only staff transaction (admin-api).
 */
export type RetentionCounter = (scope: TxScope, policy: RetentionPolicyRecord) => Promise<RetentionCount>;

/** Retention handlers by 52 entity name (e.g. "Notification"); unregistered entity types are skipped and logged. */
export class RetentionHandlers {
  readonly #handlers = new Map<string, RetentionHandler>();
  readonly #counters = new Map<string, RetentionCounter>();

  /** `counter`: the dry run of the handler; without one the dry run says not_countable (backend S21). */
  register(entityType: string, handler: RetentionHandler, counter?: RetentionCounter): void {
    if (this.#handlers.has(entityType)) throw new Error(`retention handler ${entityType} registered twice`);
    this.#handlers.set(entityType, handler);
    if (counter) this.#counters.set(entityType, counter);
  }

  get(entityType: string): RetentionHandler | undefined {
    return this.#handlers.get(entityType);
  }

  counter(entityType: string): RetentionCounter | undefined {
    return this.#counters.get(entityType);
  }
}

/** A `count(*) … GROUP BY status` result as RetentionCount (counters of entities with a status). */
export function countByStatus(rows: readonly { status: string; n: string | number | bigint }[]): RetentionCount {
  const byStatus = rows.map((r) => ({ status: r.status, count: Number(r.n) })).sort((a, b) => a.status.localeCompare(b.status));
  return { affected: byStatus.reduce((t, r) => t + r.count, 0), byStatus };
}

// ------------------------------------------------------------------ work queues (backend S21, BR-22)

/** 40 WorkQueueKey, in the order admin.work_summary lists the queues. */
export const WORK_QUEUE_KEYS = [
  'four_eyes',
  'verifications',
  'review_approvals',
  'reports',
  'cases',
  'disputes',
  'privacy_requests',
  'badge_approvals',
  'subscription_change_requests',
  'support_tickets', // backend S24 (BR-13)
] as const;
export type WorkQueueKey = (typeof WORK_QUEUE_KEYS)[number];

/** An item's target (Docs/23 §6): hours or working days from its clock start, or a fixed time (a due date, an expiry). */
export type SlaTarget = { hours: number } | { workingDays: number } | { at: Date };

/** One open item of a work queue, as its owning module sees it (no personal data). */
export interface WorkItem {
  /** When the item's clock started (submission, the business's answer, creation). */
  startedAt: Date;
  /** Null: the queue has no target. */
  target: SlaTarget | null;
  /** The clock is paused (a verification check waiting for the business). */
  paused?: boolean;
  /** Assigned to the caller (queues with an assignee). */
  mine?: boolean;
  /** Breakdown keys ('status:open', 'reason:privacy', 'source:ai_flag', 'type:review', 'severity:critical'). */
  keys?: readonly string[];
}

export interface WorkQueue {
  /** The staff roles of the queue's list operation (40 STF): only they see the queue in admin.work_summary. */
  roles: readonly StaffRole[];
  /** Items have an assignee (WorkQueueSummary.assigned_to_me). */
  assignable: boolean;
  /** Items have a target (WorkQueueSummary.sla); false: sla is null. */
  timed: boolean;
  /**
   * The exact number of open items (as the list operation shows them to `staff`) and up to `limit` of them, oldest
   * first. Runs in the caller's read-only staff transaction.
   */
  items(scope: TxScope, staff: Staff, limit: number): Promise<{ open: number; items: WorkItem[] }>;
}

/** Work queues by key; each owning module registers its queue (admin.work_summary). */
export class WorkQueues {
  readonly #queues = new Map<WorkQueueKey, WorkQueue>();

  register(key: WorkQueueKey, queue: WorkQueue): void {
    if (this.#queues.has(key)) throw new Error(`work queue ${key} registered twice`);
    this.#queues.set(key, queue);
  }

  get(key: WorkQueueKey): WorkQueue | undefined {
    return this.#queues.get(key);
  }
}

// ---------------------------------------------------------------- system health (backend S21, BR-17)

export type SystemHealthKey = 'import_failures' | 'notification_delivery_failures' | 'media_scan_failures';

/** Failures in the last 24 hours, 7 days and 30 days, and the last one within 30 days. */
export interface FailureCounts {
  last24h: number;
  last7d: number;
  last30d: number;
  lastFailureAt: Date | null;
}

/** Counts one kind of failure; runs in the caller's read-only staff transaction. */
export type HealthSignal = (scope: TxScope, now: Date) => Promise<FailureCounts>;

/** System health signals by key; a key may have several contributors (their counts add up). */
export class SystemHealthSignals {
  readonly #signals = new Map<SystemHealthKey, HealthSignal[]>();

  register(key: SystemHealthKey, signal: HealthSignal): void {
    this.#signals.set(key, [...(this.#signals.get(key) ?? []), signal]);
  }

  get(key: SystemHealthKey): readonly HealthSignal[] {
    return this.#signals.get(key) ?? [];
  }
}

/**
 * FailureCounts over the rows of `from` (a FROM … WHERE … fragment naming the failed rows) by the time column `at`.
 * Example: failureCounts(scope, sql`FROM notification.notification_deliveries WHERE status = 'failed'`, sql`updated_at`, now).
 */
export async function failureCounts(scope: TxScope, from: RawBuilder<unknown>, at: RawBuilder<unknown>, now: Date): Promise<FailureCounts> {
  const day = 86_400_000;
  const [d1, d7, d30] = [1, 7, 30].map((n) => new Date(now.getTime() - n * day));
  const { rows } = await sql<{ d1: string; d7: string; d30: string; last: Date | null }>`
    SELECT count(*) FILTER (WHERE ${at} > ${d1}) AS d1, count(*) FILTER (WHERE ${at} > ${d7}) AS d7, count(*) AS d30,
           max(${at}) AS last
      ${from} AND ${at} > ${d30}`.execute(scope.db);
  const r = rows[0];
  return { last24h: Number(r?.d1 ?? 0), last7d: Number(r?.d7 ?? 0), last30d: Number(r?.d30 ?? 0), lastFailureAt: r?.last ?? null };
}

/** Cut-off date of a retention policy. */
export const retentionCutoff = (p: RetentionPolicyRecord, now = Date.now()): Date => new Date(now - p.retentionDays * 86_400_000);

/** Display names of staff members and other actors on admin views (identity user cards, with the "former member" fallback). */
@Injectable()
export class StaffNames {
  constructor(private readonly users: UserCards) {}

  async names(scope: TxScope, ids: readonly (string | null | undefined)[], locale: string): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const cards = await this.users.cards(scope, unique);
    return new Map(unique.map((id) => [id, authorDisplayName(cards.get(id), locale)]));
  }

  async name(scope: TxScope, id: string, locale: string): Promise<string> {
    return (await this.names(scope, [id], locale)).get(id)!;
  }
}
