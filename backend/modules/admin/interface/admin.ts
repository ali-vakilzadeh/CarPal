// Public interface of the admin module (41 §2.1 M15; 40 §23, SEC-ADM). The
// admin plane's cross-module mechanics live here as ports and registries
// (GD-15), so owning modules keep their own tables:
//   FourEyes / FourEyesExecutors  4EYES operations (SEC-ADM-6): an owning
//                       module's handler files a pending change, and
//                       registers the executor that applies it when a second
//                       staff member approves (admin.four_eyes_decide).
//   PurposeQueues       CarPal-Access-Purpose binding (SEC-ADM-5): each kind
//                       (case, dispute, dsr, verification, approval) is
//                       resolved by the module that owns the queue item.
//   ModerationTargets   content owners plug their records into reports and
//                       moderation cases (existence, snapshot, hide/remove/
//                       restore/approve, owning organization).
//   ModerationLog       append-only moderation actions written by any module
//                       (52 ModerationAction) and the trust inputs they carry.
import { Injectable } from '@nestjs/common';
import { auditPiiRead } from '#libs/audit/index.js';
import type { AccessPurpose, PurposeKind } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
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
}

export function staffOf(ctx: OperationContext): Staff {
  if (ctx.principal.kind !== 'staff') throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, roles: ctx.access.platformRoles, purpose: ctx.access.purpose?.value ?? null };
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
 * entry with the access purpose (the pipeline refuses a staff PII response
 * without an audit entry).
 */
export async function auditStaffRead(
  scope: TxScope,
  staff: Staff,
  entityType: string,
  entityId: string,
  fieldsGroup: string,
): Promise<void> {
  if (!staff.purpose) throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Access-Purpose required' });
  await auditPiiRead(scope, { entityType, entityId, accessPurpose: staff.purpose, fieldsGroup });
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

export type FourEyesExecutor = (scope: TxScope, change: ApprovedChange) => Promise<void>;

export abstract class FourEyes {
  /**
   * Files a pending change (status pending, expires after 72 h) with its
   * audit entry in the caller's transaction; returns the 202 body. A second
   * pending change for the same operation and target is 409 DUPLICATE.
   */
  abstract request(scope: TxScope, staffUserId: string, r: PendingChangeRequest, locale: string): Promise<PendingChangeView>;
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

export class PurposeQueues {
  readonly #resolvers = new Map<PurposeKind, PurposeResolver>();

  register(kind: PurposeKind, resolver: PurposeResolver): void {
    if (this.#resolvers.has(kind)) throw new Error(`purpose queue ${kind} registered twice`);
    this.#resolvers.set(kind, resolver);
  }

  get(kind: PurposeKind): PurposeResolver | undefined {
    return this.#resolvers.get(kind);
  }
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

/** Content actions an owning module applies to its own record (52 ModerationAction.action_type subset). */
export type ContentAction = 'approve' | 'hide' | 'remove' | 'restore' | 'request_changes';

export interface ModerationTargetHandler {
  /** Does the record exist (not deleted)? Runs in the system context (reports from any user). */
  exists(scope: TxScope, id: string): Promise<boolean>;
  /** 40 case_get target_snapshot: plain fields for moderators, never contact data or secrets. Null when gone. */
  snapshot(scope: TxScope, id: string): Promise<Record<string, unknown> | null>;
  /** The organization the content belongs to (trust penalties, notifications), or null. */
  subjectOrganization?(scope: TxScope, id: string): Promise<string | null>;
  /** The user who wrote or owns the content (warnings, suspensions), or null. */
  author?(scope: TxScope, id: string): Promise<string | null>;
  /**
   * Applies a content action in the staff transaction. Returns false when the
   * action does not apply to the record's current state (409 INVALID_TRANSITION).
   */
  apply?(scope: TxScope, id: string, action: ContentAction): Promise<boolean>;
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
  /** One moderation action (dispute targets: appeals, the actor who made the disputed decision). */
  abstract get(
    scope: TxScope,
    id: string,
  ): Promise<{ targetType: string; targetId: string; actionType: string; actorUserId: string; params: Record<string, unknown> } | null>;
  /**
   * The parties a moderation action affected (definer admin.moderation_action_affects):
   * appeals by users and organizations, in their own RLS context.
   */
  abstract affects(scope: TxScope, actionId: string): Promise<{ userId: string | null; organizationId: string | null } | null>;
  /** Reports filed against a record (staff views: StaffUserView.counts.reports_against). */
  abstract reportsAgainst(scope: TxScope, targetType: string, targetId: string, reason?: string): Promise<number>;
  /** Open moderation cases about a record (StaffOrgView.open_cases). */
  abstract openCases(scope: TxScope, targetType: string, targetId: string): Promise<number>;
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

/** Retention handlers by 52 entity name (e.g. "Notification"); unregistered entity types are skipped and logged. */
export class RetentionHandlers {
  readonly #handlers = new Map<string, RetentionHandler>();

  register(entityType: string, handler: RetentionHandler): void {
    if (this.#handlers.has(entityType)) throw new Error(`retention handler ${entityType} registered twice`);
    this.#handlers.set(entityType, handler);
  }

  get(entityType: string): RetentionHandler | undefined {
    return this.#handlers.get(entityType);
  }
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
