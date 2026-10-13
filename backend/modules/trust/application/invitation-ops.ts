// Review invitations (40 §15.2-15.3, 52 ReviewRequest, SEC-LT ri, SEC-BF-2).
// One invitation per visit and recipient; it expires 7 days after sending.
// The system invites after a completed appointment or inquiry (W4); a
// business invites for one of its visits by in-app notification or email
// (email needs the customer's review_invitations consent and the flag
// reviews.invitation_email.enabled). The ri link is single use, sent in the
// URL fragment, stored only as an HMAC; opening it sends a one-time code to
// the invited contact, and only the verified, signed-in recipient gets the
// 30-minute grant that reviews.create consumes. A job-log invitation counts
// as the business's confirmation (Path 2, business_invited).
import { randomBytes, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { ApiError } from '#libs/contract/index.js';
import { CryptoServices, safeEqual, uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MembershipDirectory } from '#libs/authz/index.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { AccountFacts, authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { Messenger } from '#modules/notification/interface/messenger.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { PublicOrgCards } from '#modules/organization/interface/public-profiles.js';
import { TrustFigures } from '#modules/organization/interface/trust-figures.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toInvitation, type RequestRow } from '../api/projections.js';
import { CODE_ATTEMPTS, CODE_TTL_MS, GRANT_TTL_MS, INVITATION_TTL_MS, invitationPath, maskEmail } from '../domain/reviews.js';
import { afterId, member, notFoundAt, pageOf, signedIn, Subjects } from './common.js';
import { tookPlace } from './review-ops.js';

registerConstraintErrors({
  // 40 review_invitations.send 409 DUPLICATE(visit): one live invitation per visit.
  review_requests_appointment_uq: { code: 'DUPLICATE', pointer: '/appointment_id', fieldCode: 'not_unique' },
  review_requests_record_uq: { code: 'DUPLICATE', pointer: '/service_record_id', fieldCode: 'not_unique' },
  review_requests_inquiry_uq: { code: 'DUPLICATE', pointer: '/stock_inquiry_id', fieldCode: 'not_unique' },
  review_requests_job_uq: { code: 'DUPLICATE', pointer: '/provider_job_log_id', fieldCode: 'not_unique' },
});

const contactAad = (id: string) => `trust.invited_contact:${id}`;

export interface NewInvitation {
  subjectOrgId: string;
  visit: { appointment_id?: string; service_record_id?: string; stock_inquiry_id?: string; provider_job_log_id?: string };
  invitedUserId: string | null;
  invitedContact: string | null;
  invitedBy: string | null;
  channel: 'in_app' | 'email';
  businessConfirmation: boolean;
}

/** Writes invitations (business sends and W4) and mails email links after commit. */
@Injectable()
export class Invitations {
  constructor(
    private readonly links: LinkTokens,
    private readonly crypto: CryptoServices,
    private readonly messenger: Messenger,
    private readonly orgs: OrgCards,
  ) {}

  async create(scope: TxScope, n: NewInvitation): Promise<RequestRow> {
    const link = this.links.issue('ri');
    const now = new Date();
    const rowId = uuidv7();
    const contact = n.invitedContact?.trim().toLowerCase() ?? null;
    const row = await scope.db
      .insertInto('trust.review_requests')
      .values({
        id: rowId,
        subject_organization_id: n.subjectOrgId,
        appointment_id: n.visit.appointment_id ?? null,
        service_record_id: n.visit.service_record_id ?? null,
        stock_inquiry_id: n.visit.stock_inquiry_id ?? null,
        provider_job_log_id: n.visit.provider_job_log_id ?? null,
        invited_user_id: n.invitedUserId,
        invited_contact_encrypted: contact ? this.crypto.envelope.encrypt(contact, contactAad(rowId)) : null,
        invited_contact_hash: contact ? this.crypto.hmac.digest('contact-hash', contact) : null,
        invited_by_user_id: n.invitedBy,
        channel: n.channel,
        link_token_hash: link.hash,
        business_confirmation_given: n.businessConfirmation,
        sent_at: now,
        last_sent_at: now,
        status: 'sent',
        expires_at: new Date(now.getTime() + INVITATION_TTL_MS),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (n.channel === 'email') await this.mailLink(scope, row, link.token, 'review.invitation');
    await publishEvent(scope, {
      type: 'review.invitation.sent',
      aggregateType: 'review_request',
      aggregateId: row.id,
      payload: { subject_organization_id: row.subject_organization_id, invited_user_id: row.invited_user_id, channel: row.channel },
    });
    return row;
  }

  /** The ri link by email (Messenger, never an event or a notification: it carries the token). */
  async mailLink(scope: TxScope, row: RequestRow, token: string, template: string): Promise<void> {
    const to = await this.contact(scope, row.id);
    if (!to) return;
    const org = (await this.orgs.cards(scope, [row.subject_organization_id])).get(row.subject_organization_id);
    scope.afterCommit(() =>
      this.messenger.email(to.email, template, to.locale, { link: this.links.link('ri', token), organization_name: org?.name ?? 'CarPal' }),
    );
  }

  /** The invited contact (definer trust.invitation_contact): the user's verified email, or the decrypted invited address. */
  async contact(scope: TxScope, requestId: string, tokenHash?: Buffer): Promise<{ email: string; locale: string } | null> {
    const { rows } = await sql<{ email: string | null; locale: string; contact_encrypted: Buffer | null }>`
      SELECT email, locale, contact_encrypted FROM trust.invitation_contact(${requestId}::uuid, ${tokenHash ?? null})`.execute(scope.db);
    const r = rows[0];
    if (!r) return null;
    if (r.email) return { email: r.email, locale: r.locale };
    if (r.contact_encrypted)
      return { email: this.crypto.envelope.decrypt(r.contact_encrypted, contactAad(requestId)).toString('utf8'), locale: r.locale };
    return null;
  }
}

/** Invitation views with the subject summary and the invitee's display name. */
@Injectable()
export class InvitationViews {
  constructor(
    private readonly subjects: Subjects,
    private readonly users: UserCards,
  ) {}

  async many(scope: TxScope, rows: readonly RequestRow[], locale: string) {
    const subjects = await this.subjects.summaries(
      scope,
      rows.map((r) => r.subject_organization_id),
    );
    const users = await this.users.cards(
      scope,
      rows.map((r) => r.invited_user_id).filter((x): x is string => !!x),
    );
    return rows.map((r) => {
      const subject = subjects.get(r.subject_organization_id);
      if (!subject) throw new ApiError('INTERNAL', { detail: `invitation ${r.id}: subject card missing` });
      return toInvitation(r, subject, r.invited_user_id ? authorDisplayName(users.get(r.invited_user_id), locale) : null);
    });
  }
}

@Injectable()
@Operation('review_invitations.mine_list')
export class ReviewInvitationsMineListHandler implements OperationHandler {
  constructor(private readonly views: InvitationViews) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('trust.review_requests')
          .selectAll()
          .where('invited_user_id', '=', c.userId)
          .where('status', 'in', ['sent', 'opened', 'reminded'])
          .where('expires_at', '>', sql<Date>`now()`)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, ctx.query.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

type InvitationSend = {
  appointment_id?: string;
  service_record_id?: string;
  stock_inquiry_id?: string;
  provider_job_log_id?: string;
  channel: 'in_app' | 'email';
  invited_contact?: string;
};

@Injectable()
@Operation('review_invitations.send')
export class ReviewInvitationsSendHandler implements OperationHandler {
  constructor(
    private readonly invitations: Invitations,
    private readonly views: InvitationViews,
    private readonly appointments: AppointmentFacts,
    private readonly inventory: InventoryRead,
    private readonly ext: OrganizationExtensions,
    private readonly figures: TrustFigures,
    private readonly consents: ConsentChecker,
    private readonly memberships: MembershipDirectory,
  ) {}

  async handle(ctx: OperationContext<InvitationSend>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const visits = (['appointment_id', 'service_record_id', 'stock_inquiry_id', 'provider_job_log_id'] as const).filter((k) => b[k]);
    // C: exactly one visit; invited_contact only for a job log of a customer without an account.
    if (visits.length !== 1)
      throw ApiError.validation([{ pointer: '/appointment_id', code: visits.length ? 'conditional_forbidden' : 'conditional_required' }]);
    if (b.invited_contact && (!b.provider_job_log_id || b.channel !== 'email'))
      throw ApiError.validation([{ pointer: '/invited_contact', code: 'conditional_forbidden' }]);
    if (b.channel === 'email' && !(await ctx.flagEnabled('reviews.invitation_email.enabled'))) throw new ApiError('FEATURE_DISABLED');
    const body = await ctx.tx(async (scope) => {
      let invitedUserId: string | null;
      if (b.appointment_id) {
        const a = (await this.appointments.visits(scope, [b.appointment_id])).get(b.appointment_id);
        if (!a || a.providerOrgId !== m.orgId || !tookPlace(a, Date.now())) throw notFoundAt('/appointment_id');
        invitedUserId = a.requesterUserId;
      } else if (b.service_record_id) {
        const v = await this.ext.visit(scope, 'service_record', m.orgId, b.service_record_id);
        if (!v) throw notFoundAt('/service_record_id');
        invitedUserId = v.customerUserId;
      } else if (b.stock_inquiry_id) {
        const q = (await this.inventory.inquiryVisits(scope, { ids: [b.stock_inquiry_id], vendorOrgId: m.orgId }))[0];
        if (!q || q.status !== 'completed') throw notFoundAt('/stock_inquiry_id');
        invitedUserId = q.requesterUserId;
      } else {
        const j = await this.figures.jobLog(scope, m.orgId, b.provider_job_log_id!);
        if (!j) throw notFoundAt('/provider_job_log_id');
        invitedUserId = j.vehicleId ? await this.ext.vehicleOwner(scope, j.vehicleId) : null;
        if (!invitedUserId && !b.invited_contact)
          throw ApiError.validation([{ pointer: '/invited_contact', code: 'conditional_required' }]);
        if (invitedUserId && b.invited_contact) throw ApiError.validation([{ pointer: '/invited_contact', code: 'conditional_forbidden' }]);
      }
      // SEC-BF-2 self-review pattern: the business cannot invite its own members.
      if (invitedUserId && (await this.memberships.memberships(invitedUserId, 'user')).some((x) => x.orgId === m.orgId))
        throw new ApiError('REVIEW_NOT_ALLOWED', { detail: 'self_review_pattern' });
      if (invitedUserId && invitedUserId === m.userId) throw new ApiError('REVIEW_NOT_ALLOWED', { detail: 'self_review_pattern' });
      // CNS(review_invitations: email): channels other than in-app need the customer's consent (52 ReviewRequest).
      if (b.channel === 'email' && invitedUserId) {
        const granted = await this.consents.isGranted(scope, {
          consentType: 'review_invitations',
          subject: { type: 'user', id: invitedUserId },
        });
        if (!granted)
          throw new ApiError('CONSENT_REQUIRED', { detail: 'review_invitations', extensions: { consent_type: 'review_invitations' } });
      }
      if (b.channel === 'in_app' && !invitedUserId) throw ApiError.validation([{ pointer: '/channel', code: 'enum' }]);
      const row = await this.invitations.create(scope, {
        subjectOrgId: m.orgId,
        visit: {
          ...(b.appointment_id ? { appointment_id: b.appointment_id } : {}),
          ...(b.service_record_id ? { service_record_id: b.service_record_id } : {}),
          ...(b.stock_inquiry_id ? { stock_inquiry_id: b.stock_inquiry_id } : {}),
          ...(b.provider_job_log_id ? { provider_job_log_id: b.provider_job_log_id } : {}),
        },
        invitedUserId,
        invitedContact: invitedUserId ? null : (b.invited_contact ?? null),
        invitedBy: m.userId,
        channel: b.channel,
        businessConfirmation: !!b.provider_job_log_id,
      });
      return (await this.views.many(scope, [row], ctx.locale))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/review-invitations/${body.id}`);
  }
}

@Injectable()
@Operation('review_invitations.org_list')
export class ReviewInvitationsOrgListHandler implements OperationHandler {
  constructor(private readonly views: InvitationViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('trust.review_requests')
          .selectAll()
          .where('subject_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, ctx.query.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('review_invitations.cancel')
export class ReviewInvitationsCancelHandler implements OperationHandler {
  constructor(private readonly views: InvitationViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await scope.db
        .selectFrom('trust.review_requests')
        .selectAll()
        .where('id', '=', ctx.params.invitation_id!)
        .where('subject_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw new ApiError('NOT_FOUND');
      if (!['pending', 'sent', 'opened', 'reminded'].includes(r.status)) throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      // The link stops working: trust.open_invitation refuses cancelled invitations (LINK_EXPIRED).
      const row = await scope.db
        .updateTable('trust.review_requests')
        .set({ status: 'cancelled' })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.many(scope, [row], ctx.locale))[0]!;
    });
    return { body };
  }
}

type OpenRow = {
  invitation_id: string;
  subject_organization_id: string;
  appointment_id: string | null;
  service_record_id: string | null;
  stock_inquiry_id: string | null;
  provider_job_log_id: string | null;
  invited_user_id: string | null;
  expires_at: Date;
  business_confirmation_given: boolean;
};

type StoredCode = { h: string; attempts: number };

@Injectable()
@Operation('review_invitations.open')
export class ReviewInvitationsOpenHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly invitations: Invitations,
    private readonly crypto: CryptoServices,
    private readonly messenger: Messenger,
    private readonly cards: PublicOrgCards,
    private readonly orgs: OrgCards,
    private readonly appointments: AppointmentFacts,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  async handle(ctx: OperationContext<{ token: string }>): Promise<OperationResult> {
    const { hash } = this.links.parse(ctx.body.token, 'ri');
    const body = await ctx.tx(async (scope) => {
      // trust.open_invitation: atomic, records opened_at once (review.invitation.opened), 410 for expired, used or cancelled links.
      const { rows } = await sql<OpenRow>`SELECT * FROM trust.open_invitation(${hash})`.execute(scope.db);
      const r = rows[0];
      if (!r) throw new ApiError('LINK_EXPIRED');
      const to = await this.invitations.contact(scope, r.invitation_id, hash);
      if (!to) throw new ApiError('LINK_EXPIRED', { detail: 'no contact' });
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const stored: StoredCode = { h: this.crypto.hmac.digest('otp', `ri:${r.invitation_id}:${code}`).toString('base64'), attempts: 0 };
      await this.infra.kv.set(`ri_code:${r.invitation_id}`, JSON.stringify(stored), { ttlMs: CODE_TTL_MS });
      scope.afterCommit(() => this.messenger.email(to.email, 'review.invitation_code', to.locale, { code }));
      let subject = (await this.cards.cards(scope, [r.subject_organization_id], ctx.locale)).get(r.subject_organization_id);
      if (!subject) {
        const c = (await this.orgs.cards(scope, [r.subject_organization_id])).get(r.subject_organization_id);
        if (!c) throw new ApiError('LINK_EXPIRED');
        subject = {
          id: c.id,
          slug: c.slug,
          name: c.name,
          organization_type: c.organizationType,
          roles: [],
          verified: c.verificationStatus === 'verified',
          overall_rating: null,
          review_count: 0,
          top_badges: [],
          price_tier: null,
          measured_response_time_minutes: null,
          logo_url: c.logoUrl,
          portfolio_thumbnail_url: null,
        };
      }
      return {
        invitation_id: r.invitation_id,
        subject,
        visit_context: await visitContext(scope, r.appointment_id, ctx.locale, this.appointments, this.vehicles, this.taxonomy),
        expires_at: new Date(r.expires_at).toISOString(),
        path: invitationPath(r),
        code_sent_to: maskEmail(to.email),
      };
    });
    return { body, cache: 'no-store' };
  }
}

/** 40 ReviewApprovalView.visit_context of an appointment (taxonomy and date only); other visits show nulls. */
export async function visitContext(
  scope: TxScope,
  appointmentId: string | null,
  locale: string,
  appointments: AppointmentFacts,
  vehicles: VehicleCards,
  taxonomy: TaxonomyResolver,
  fallback: {
    system?: string | null;
    task?: string | null;
    date?: string | null;
    vehicleId?: string | null;
    locationId?: string | null;
  } = {},
) {
  const a = appointmentId ? (await appointments.visits(scope, [appointmentId])).get(appointmentId) : undefined;
  const vehicleId = a?.vehicleId ?? fallback.vehicleId ?? null;
  const v = vehicleId ? (await vehicles.cards(scope, [vehicleId])).get(vehicleId) : undefined;
  const system = a?.serviceSystemNodeId ?? fallback.system ?? null;
  const task = a?.serviceTaskNodeId ?? fallback.task ?? null;
  const labels = await taxonomy.labels(
    [system, task, v?.brandNodeId, v?.modelNodeId].filter((x): x is string => !!x),
    locale as never,
  );
  const lb = (id: string | null | undefined) => (id ? (labels.get(id) ?? null) : null);
  const brand = lb(v?.brandNodeId);
  const model = lb(v?.modelNodeId);
  return {
    service_system: lb(system),
    service_task: lb(task),
    service_date: a?.confirmedStartAt ? a.confirmedStartAt.toISOString().slice(0, 10) : (fallback.date ?? null),
    vehicle: brand && model ? { brand, model } : null,
    location_id: a?.providerLocationId ?? fallback.locationId ?? null,
  };
}

type TokenRow = {
  id: string;
  subject_organization_id: string;
  provider_job_log_id: string | null;
  invited_user_id: string | null;
  invited_contact_hash: Buffer | null;
  status: string;
  token_used_at: Date | null;
  expires_at: Date | null;
};

@Injectable()
@Operation('review_invitations.verify')
export class ReviewInvitationsVerifyHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly crypto: CryptoServices,
    private readonly facts: AccountFacts,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  async handle(ctx: OperationContext<{ token: string; code: string }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const { hash } = this.links.parse(ctx.body.token, 'ri');
    const body = await ctx.tx(async (scope) => {
      const { rows } = await sql<TokenRow>`SELECT * FROM trust.invitation_by_token(${hash})`.execute(scope.db);
      const r = rows[0];
      // SEC-LT-4: unknown, expired and cancelled links are 410 LINK_EXPIRED; used ones 410 LINK_USED.
      if (!r) throw new ApiError('LINK_EXPIRED');
      if (r.token_used_at || r.status === 'converted') throw new ApiError('LINK_USED');
      if (!['sent', 'opened', 'reminded'].includes(r.status) || !r.expires_at || new Date(r.expires_at).getTime() < Date.now())
        throw new ApiError('LINK_EXPIRED');
      // SEC-LT-5: the signed-in user must be the invited person (user id, or the invited address verified on their account).
      if (r.invited_user_id !== c.userId) {
        const email = r.invited_user_id ? null : await this.facts.verifiedEmail(scope, c.userId);
        const ok =
          !!email &&
          !!r.invited_contact_hash &&
          safeEqual(this.crypto.hmac.digest('contact-hash', email.trim().toLowerCase()), r.invited_contact_hash);
        if (!ok) throw new ApiError('LINK_RECIPIENT_MISMATCH');
      }
      const key = `ri_code:${r.id}`;
      const raw = await this.infra.kv.get(key);
      const stored = raw ? (JSON.parse(raw) as StoredCode) : null;
      const given = this.crypto.hmac.digest('otp', `ri:${r.id}:${ctx.body.code}`).toString('base64');
      if (!stored || stored.attempts >= CODE_ATTEMPTS || !safeEqual(stored.h, given)) {
        if (stored)
          await this.infra.kv.set(key, JSON.stringify({ ...stored, attempts: stored.attempts + 1 }), { mode: 'XX', ttlMs: CODE_TTL_MS });
        throw ApiError.validation([{ pointer: '/code', code: 'pattern' }], 'CODE_INVALID');
      }
      const { rows: claimed } = await sql<{ id: string | null }>`SELECT trust.claim_invitation(${hash}) AS id`.execute(scope.db);
      if (!claimed[0]?.id) throw new ApiError('LINK_EXPIRED');
      await this.infra.kv.del(key);
      const grant = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
      scope.afterCommit(async () => {
        await this.infra.kv.set(`ri_grant:${grant}`, JSON.stringify({ invitationId: r.id, userId: c.userId }), { ttlMs: GRANT_TTL_MS });
      });
      return { invitation_grant: grant, expires_at: expiresAt.toISOString(), path: invitationPath(r) };
    });
    return { body, cache: 'no-store' };
  }
}
