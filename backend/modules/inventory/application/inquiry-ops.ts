// Stock inquiries (40 §13.2-13.3, 52 StockInquiry / InquiryMessage): the
// requester side ({me}/inquiries for individuals, {org}/inquiries for
// providers and fleets) and the vendor side ({vnd}/inquiries). No checkout:
// either side completes. Transitions follow 40 §13.1 per side (checked here
// and again by the stock_inquiries_rules trigger, SEC-IC-5). A vehicle
// context is shared only through a vendor_fitment_context consent scoped to
// the inquiry and granted to the vendor, created atomically with it; the
// vendor sees the snapshot (taxonomy and year, never VIN or plate) only
// while that consent is granted (SEC-AZ-8).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { l10n, type Locale } from '#libs/i18n/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AccountFacts, ConsentGrants, UserCards } from '#modules/identity/interface/identity.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toInquiryMessage, toStockInquiry, type InquiryRow, type MessageRow, type VehicleSnapshot } from '../api/projections.js';
import { INQUIRY_GROUPS, inquiryClosed, inquiryTransitionAllowed, MAX_RESERVATION_MS, type Side } from '../domain/rules.js';
import { afterId, CatalogQuality, failIf, notFoundAt, vendorMember } from './common.js';

registerConstraintErrors({
  // One open inquiry per user and item (40 inquiries.create: 409 DUPLICATE(open_inquiry_same_item)).
  stock_inquiries_open_uq: { code: 'DUPLICATE', pointer: '/inventory_item_id', fieldCode: 'not_unique' },
});

/** The requester of {RQ}/inquiries: the user ({me}) or the provider/fleet organization ({org}). */
interface Requester {
  userId: string;
  orgId: string | null;
  type: 'user' | 'provider' | 'fleet';
}

function requester(ctx: OperationContext): Requester {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  const org = ctx.access.org;
  if (!org) return { userId: ctx.principal.userId, orgId: null, type: 'user' };
  // requester_type follows the organization type (40 §13.3); P* and FC only reach provider-side and fleet organizations.
  return { userId: ctx.principal.userId, orgId: org.id, type: org.type === 'fleet' ? 'fleet' : 'provider' };
}

/** Stored snapshot (node ids and year; labels are resolved per request). */
type StoredSnapshot = {
  brand_node_id: string;
  model_node_id: string;
  series_node_id: string | null;
  year: number;
  engine_type_node_id: string | null;
};

@Injectable()
export class InquiryViews {
  constructor(
    private readonly orgs: OrgCards,
    private readonly users: UserCards,
    private readonly consents: ConsentChecker,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async #names(scope: TxScope, rows: readonly InquiryRow[]) {
    const orgs = await this.orgs.cards(scope, [
      ...rows.map((r) => r.vendor_organization_id),
      ...rows.map((r) => r.requester_organization_id).filter((x): x is string => !!x),
    ]);
    const users = await this.users.cards(
      scope,
      rows.filter((r) => r.requester_type === 'user').map((r) => r.requester_user_id),
    );
    const requesterDisplay = (r: InquiryRow): string => {
      const name = r.requester_organization_id ? orgs.get(r.requester_organization_id)?.name : users.get(r.requester_user_id)?.displayName;
      const n = name?.trim();
      return n && n.length >= 2 ? n.slice(0, 120) : 'CarPal user';
    };
    return { orgs, requesterDisplay };
  }

  async #snapshot(scope: TxScope, r: InquiryRow, side: Side, locale: Locale): Promise<VehicleSnapshot | null> {
    const s = r.vehicle_context_snapshot as StoredSnapshot | null;
    if (!s) return null;
    // CNS(vendor_fitment_context: for vehicle snapshot): checked on every vendor read, never cached; withdrawal hides it at once.
    if (side === 'vendor') {
      const granted = await this.consents.isGranted(scope, {
        consentType: 'vendor_fitment_context',
        subject: { type: 'user', id: r.requester_user_id },
        scopeEntity: { type: 'stock_inquiry', id: r.id },
        grantee: { type: 'organization', id: r.vendor_organization_id },
      });
      if (!granted) return null;
    }
    const ids = [s.brand_node_id, s.model_node_id, s.series_node_id, s.engine_type_node_id].filter((x): x is string => !!x);
    const labels = await this.taxonomy.labels(ids, locale);
    const label = (id: string | null) => (id ? (labels.get(id) ?? null) : null);
    const brand = label(s.brand_node_id);
    const model = label(s.model_node_id);
    if (!brand || !model) return null;
    return { brand, model, series: label(s.series_node_id), year: s.year, engine: label(s.engine_type_node_id) };
  }

  async many(scope: TxScope, rows: readonly InquiryRow[], side: Side, locale: Locale) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const { rows: items } = await sql<{ inquiry_id: string; item_id: string; sku: string; name_translations: Record<string, string> }>`
      SELECT * FROM inventory.inquiry_item_cards(${sql.val(ids)}::uuid[])`.execute(scope.db);
    const itemOf = new Map(items.map((i) => [i.inquiry_id, i]));
    const last = await scope.db
      .selectFrom('inventory.inquiry_messages')
      .select(['inquiry_id', (eb) => eb.fn.max<Date>('created_at').as('at')])
      .where('inquiry_id', 'in', ids)
      .where('deleted_at', 'is', null)
      .groupBy('inquiry_id')
      .execute();
    const lastAt = new Map(last.map((l) => [l.inquiry_id, l.at]));
    const { orgs, requesterDisplay } = await this.#names(scope, rows);
    const out = [];
    for (const r of rows) {
      const item = itemOf.get(r.id);
      const vendor = orgs.get(r.vendor_organization_id);
      if (!item || !vendor) throw new ApiError('INTERNAL', { detail: `inquiry ${r.id}: item or vendor card missing` });
      out.push(
        toStockInquiry(r, {
          item: { id: item.item_id, name: l10n(item.name_translations, locale)!, sku: item.sku },
          vendor: toOrgSummary(vendor),
          requesterDisplay: requesterDisplay(r),
          snapshot: await this.#snapshot(scope, r, side, locale),
          lastMessageAt: lastAt.get(r.id) ?? null,
          // Path 1 (inquiry_verified): a completed inquiry lets its requester review the vendor (52 §21).
          canReview: side === 'requester' && r.status === 'completed',
        }),
      );
    }
    return out;
  }

  /** The inquiry with its thread (≤ 200 messages, oldest first); authors are shown by side, never by staff name. */
  async withMessages(scope: TxScope, r: InquiryRow, side: Side, locale: Locale) {
    const [inquiry] = await this.many(scope, [r], side, locale);
    const messages = await scope.db
      .selectFrom('inventory.inquiry_messages')
      .selectAll()
      .where('inquiry_id', '=', r.id)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .limit(200)
      .execute();
    return { inquiry: inquiry!, messages: messages.map((msg) => this.message(msg, inquiry!)) };
  }

  message(m: MessageRow, inquiry: { vendor: unknown; requester_display: string }) {
    const vendorName = (inquiry.vendor as { name: string }).name;
    return toInquiryMessage(m, m.author_side === 'vendor' ? vendorName : inquiry.requester_display);
  }
}

async function loadAsRequester(scope: TxScope, r: Requester, id: string, lock = false): Promise<InquiryRow> {
  let q = scope.db.selectFrom('inventory.stock_inquiries').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  q = r.orgId
    ? q.where('requester_organization_id', '=', r.orgId)
    : q.where('requester_type', '=', 'user').where('requester_user_id', '=', r.userId);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

async function loadAsVendor(scope: TxScope, vendorOrgId: string, id: string, lock = false): Promise<InquiryRow> {
  const q = scope.db
    .selectFrom('inventory.stock_inquiries')
    .selectAll()
    .where('id', '=', id)
    .where('vendor_organization_id', '=', vendorOrgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

async function addMessage(scope: TxScope, inquiryId: string, userId: string, side: Side, body: { body: string; content_locale: string }) {
  return scope.db
    .insertInto('inventory.inquiry_messages')
    .values({ inquiry_id: inquiryId, author_user_id: userId, author_side: side, body: body.body, content_locale: body.content_locale })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * inquiry.status_changed (S7, DI-45 family): the requester learns of answers
 * and closings (W5 inquiry_answered) and a completed inquiry starts the
 * vendor review invitation (W4, 52 §21 inquiry_verified). Ids only.
 */
async function statusChanged(scope: TxScope, before: InquiryRow, after: InquiryRow): Promise<void> {
  if (before.status === after.status) return;
  await publishEvent(scope, {
    type: 'inquiry.status_changed',
    aggregateType: 'stock_inquiry',
    aggregateId: after.id,
    payload: {
      old_status: before.status,
      new_status: after.status,
      vendor_organization_id: after.vendor_organization_id,
      requester_user_id: after.requester_user_id,
      requester_type: after.requester_type,
    },
  });
}

const page = <T>(ctx: OperationContext<unknown, { limit: number }>, rows: InquiryRow[], views: T[]) =>
  ctx.page(views.slice(0, ctx.query.limit), rows.length > ctx.query.limit ? { id: rows[ctx.query.limit - 1]!.id } : null);

// ------------------------------------------------------------ requester side

type InquiryCreate = {
  inventory_item_id: string;
  quantity?: number;
  message: string;
  content_locale: string;
  share_vehicle_context?: { vehicle_id: string; policy_version: string };
};

@Injectable()
@Operation('inquiries.create')
export class InquiriesCreateHandler implements OperationHandler {
  constructor(
    private readonly facts: AccountFacts,
    private readonly profiles: PublicProfiles,
    private readonly vehicles: VehicleCards,
    private readonly grants: ConsentGrants,
    private readonly views: InquiryViews,
  ) {}

  async handle(ctx: OperationContext<InquiryCreate>): Promise<OperationResult> {
    const r = requester(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      // 52 §4: inquiries need a verified email or phone.
      if (!(await this.facts.hasVerifiedContact(scope, r.userId))) throw new ApiError('VERIFIED_CONTACT_REQUIRED');
      // An item visible to the caller (RLS public_read / trade_read) of a published vendor, never the caller's own.
      const item = await scope.db
        .selectFrom('inventory.inventory_items')
        .select(['id', 'vendor_organization_id', 'visibility'])
        .where('id', '=', b.inventory_item_id)
        .where('status', '=', 'active')
        .where('visibility', '<>', 'hidden')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!item || item.vendor_organization_id === r.orgId) throw notFoundAt('/inventory_item_id');
      if (!(await this.profiles.vendors(scope, [item.vendor_organization_id])).has(item.vendor_organization_id))
        throw notFoundAt('/inventory_item_id');
      const id = uuidv7();
      let snapshot: StoredSnapshot | null = null;
      let consentId: string | null = null;
      if (b.share_vehicle_context) {
        // The caller's own vehicle (personal, or the fleet's); the snapshot never holds VIN, plate or owner.
        const v = await this.vehicles.visible(scope, b.share_vehicle_context.vehicle_id);
        if (!v) throw notFoundAt('/share_vehicle_context/vehicle_id');
        snapshot = {
          brand_node_id: v.brandNodeId,
          model_node_id: v.modelNodeId,
          series_node_id: v.seriesNodeId,
          year: v.year,
          engine_type_node_id: v.engineTypeNodeId,
        };
        consentId = await this.grants.grantScoped(scope, {
          subjectUserId: r.userId,
          consentType: 'vendor_fitment_context',
          scope: { type: 'stock_inquiry', id },
          grantee: { type: 'organization', id: item.vendor_organization_id },
          policyVersion: b.share_vehicle_context.policy_version,
        });
      }
      const row = await scope.db
        .insertInto('inventory.stock_inquiries')
        .values({
          id,
          inventory_item_id: item.id,
          vendor_organization_id: item.vendor_organization_id,
          requester_type: r.type,
          requester_user_id: r.userId,
          requester_organization_id: r.orgId,
          vehicle_id: b.share_vehicle_context?.vehicle_id ?? null,
          vehicle_context_snapshot: snapshot ? JSON.stringify(snapshot) : null,
          consent_reference_id: consentId,
          quantity: b.quantity ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await addMessage(scope, row.id, r.userId, 'requester', { body: b.message, content_locale: b.content_locale });
      await publishEvent(scope, {
        type: 'inquiry.sent',
        aggregateType: 'stock_inquiry',
        aggregateId: row.id,
        payload: {
          vendor_organization_id: row.vendor_organization_id,
          inventory_item_id: row.inventory_item_id,
          requester_type: row.requester_type,
          vehicle_context_shared: snapshot !== null,
        },
      });
      return (await this.views.many(scope, [row], 'requester', ctx.locale))[0]!;
    });
    return created(body, `${r.orgId ? `/v1/orgs/${r.orgId}` : '/v1/me'}/inquiries/${body.id}`);
  }
}

@Injectable()
@Operation('inquiries.list')
export class InquiriesListHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const r = requester(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('inventory.stock_inquiries').selectAll().where('deleted_at', 'is', null);
        q = r.orgId
          ? q.where('requester_organization_id', '=', r.orgId)
          : q.where('requester_type', '=', 'user').where('requester_user_id', '=', r.userId);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return page(ctx, rows, await this.views.many(scope, rows.slice(0, ctx.query.limit), 'requester', ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('inquiries.get')
export class InquiriesGetHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(
      async (scope) => this.views.withMessages(scope, await loadAsRequester(scope, r, ctx.params.inquiry_id!), 'requester', ctx.locale),
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('inquiries.message')
export class InquiriesMessageHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext<{ body: string; content_locale: string }>): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const q = await loadAsRequester(scope, r, ctx.params.inquiry_id!, true);
      if (inquiryClosed(q.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'closed' });
      const msg = await addMessage(scope, q.id, r.userId, 'requester', ctx.body);
      const [view] = await this.views.many(scope, [q], 'requester', ctx.locale);
      return this.views.message(msg, view!);
    });
    return created(body, `${r.orgId ? `/v1/orgs/${r.orgId}` : '/v1/me'}/inquiries/${ctx.params.inquiry_id}`);
  }
}

@Injectable()
@Operation('inquiries.transition')
export class InquiriesTransitionHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext<{ to: 'cancelled' | 'completed' }>): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const q = await loadAsRequester(scope, r, ctx.params.inquiry_id!, true);
      if (!inquiryTransitionAllowed('requester', q.status, ctx.body.to))
        throw new ApiError('INVALID_TRANSITION', { detail: `${q.status} -> ${ctx.body.to}` });
      const row = await scope.db
        .updateTable('inventory.stock_inquiries')
        .set({ status: ctx.body.to, reserved_until: null, ...(ctx.body.to === 'completed' ? { closed_by_side: 'requester' } : {}) })
        .where('id', '=', q.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await statusChanged(scope, q, row);
      return (await this.views.many(scope, [row], 'requester', ctx.locale))[0]!;
    });
    return { body };
  }
}

// ------------------------------------------------------------ vendor side

@Injectable()
@Operation('inquiries.vendor_list')
export class InquiriesVendorListHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext<undefined, { group?: keyof typeof INQUIRY_GROUPS; limit: number }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('inventory.stock_inquiries')
          .selectAll()
          .where('vendor_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.group) q = q.where('status', 'in', INQUIRY_GROUPS[ctx.query.group]);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return page(ctx, rows, await this.views.many(scope, rows.slice(0, ctx.query.limit), 'vendor', ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('inquiries.vendor_get')
export class InquiriesVendorGetHandler implements OperationHandler {
  constructor(private readonly views: InquiryViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const body = await ctx.tx(
      async (scope) => this.views.withMessages(scope, await loadAsVendor(scope, m.orgId, ctx.params.inquiry_id!), 'vendor', ctx.locale),
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('inquiries.vendor_message')
export class InquiriesVendorMessageHandler implements OperationHandler {
  constructor(
    private readonly views: InquiryViews,
    private readonly quality: CatalogQuality,
  ) {}

  async handle(ctx: OperationContext<{ body: string; content_locale: string }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const body = await ctx.tx(async (scope) => {
      let q = await loadAsVendor(scope, m.orgId, ctx.params.inquiry_id!, true);
      if (inquiryClosed(q.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'closed' });
      const msg = await addMessage(scope, q.id, m.userId, 'vendor', ctx.body);
      // The first reply answers a sent inquiry; the trigger records first_response_at (response-time metric).
      if (q.status === 'sent') {
        const before = q;
        q = await scope.db
          .updateTable('inventory.stock_inquiries')
          .set({ status: 'answered' })
          .where('id', '=', q.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await statusChanged(scope, before, q);
        await this.quality.refreshVendor(scope, m.orgId);
      }
      const [view] = await this.views.many(scope, [q], 'vendor', ctx.locale);
      return this.views.message(msg, view!);
    });
    return created(body, `/v1/orgs/${m.orgId}/vendor/inquiries/${ctx.params.inquiry_id}`);
  }
}

@Injectable()
@Operation('inquiries.vendor_transition')
export class InquiriesVendorTransitionHandler implements OperationHandler {
  constructor(
    private readonly views: InquiryViews,
    private readonly quality: CatalogQuality,
  ) {}

  async handle(
    ctx: OperationContext<{ to: 'answered' | 'reserved' | 'unavailable' | 'completed' | 'cancelled'; reserved_until?: string }>,
  ) {
    const m = vendorMember(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    if (b.to === 'reserved') {
      // C: required for reserved; in the future and ≤ 14 days ahead.
      const until = b.reserved_until ? new Date(b.reserved_until).getTime() : null;
      if (until === null) errors.push({ pointer: '/reserved_until', code: 'conditional_required' });
      else if (until <= Date.now()) errors.push({ pointer: '/reserved_until', code: 'in_past' });
      else if (until > Date.now() + MAX_RESERVATION_MS) errors.push({ pointer: '/reserved_until', code: 'out_of_range' });
    } else if (b.reserved_until) errors.push({ pointer: '/reserved_until', code: 'conditional_forbidden' });
    failIf(errors);
    const body = await ctx.tx(async (scope) => {
      const q = await loadAsVendor(scope, m.orgId, ctx.params.inquiry_id!, true);
      if (!inquiryTransitionAllowed('vendor', q.status, b.to))
        throw new ApiError('INVALID_TRANSITION', { detail: `${q.status} -> ${b.to}` });
      const row = await scope.db
        .updateTable('inventory.stock_inquiries')
        .set({
          status: b.to,
          reserved_until: b.to === 'reserved' ? new Date(b.reserved_until!) : null,
          ...(b.to === 'completed' ? { closed_by_side: 'vendor' } : {}),
        })
        .where('id', '=', q.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await statusChanged(scope, q, row);
      await this.quality.refreshVendor(scope, m.orgId);
      return (await this.views.many(scope, [row], 'vendor', ctx.locale))[0]!;
    });
    return { body } satisfies OperationResult;
  }
}
