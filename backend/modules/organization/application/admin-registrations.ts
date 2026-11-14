// Organization's plug-ins for the admin plane (S8): the verification purpose
// queue, the four-eyes executor of admin.org_merge, moderation targets
// (organization, organization_location, portfolio_item — approval publishes a
// showcase and makes its media publicly servable), and its part of data
// subject requests (provider notes about a customer: exported, and deleted
// with the account).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { Authorizer } from '#libs/authz/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { excerpt, FourEyesExecutors, ModerationTargets, PurposeQueues, type ContentAction } from '#modules/admin/interface/admin.js';
import { authorDisplayName, ConsentGrants, PersonalDataRegistry, UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { OrgCards } from '../interface/org-cards.js';
import { mergeOrganization } from './admin-ops.js';

@Injectable()
export class OrganizationAdminRegistrations implements OnModuleInit {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly cards: OrgCards,
    @Optional() private readonly media?: MediaService,
    @Optional() private readonly purposes?: PurposeQueues,
    @Optional() private readonly executors?: FourEyesExecutors,
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
    @Optional() private readonly gauges?: MetricGauges,
    @Optional() private readonly consents?: ConsentGrants,
    @Optional() private readonly users?: UserCards,
  ) {}

  /** 40 ShowcaseConsent of a showcase (S18, BR-33): the customer's consent record, by display name only. */
  private async showcaseConsent(scope: TxScope, consentId: string | null, locale: string) {
    const c = consentId ? await this.consents?.record(scope, consentId) : null;
    if (!c) return null;
    const card = c.subjectType === 'user' ? (await this.users?.cards(scope, [c.subjectId]))?.get(c.subjectId) : undefined;
    return {
      customer_display_name: authorDisplayName(card, locale),
      consent_type: c.consentType,
      scope: c.scope,
      granted: c.granted,
      granted_at: c.grantedAt ? c.grantedAt.toISOString() : null,
      withdrawn_at: c.withdrawnAt ? c.withdrawnAt.toISOString() : null,
      expires_at: c.expiresAt ? c.expiresAt.toISOString() : null,
    };
  }

  /** Moderator decisions on a showcase item (52 PortfolioItem: published only after moderation approves). */
  private async portfolio(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
    const p = await scope.db
      .selectFrom('organization.portfolio_items')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!p) return false;
    if (action === 'approve') {
      if (p.status !== 'pending_review' || !['not_required', 'granted'].includes(p.customer_consent_status)) return false;
      await this.media?.moderateAttached(scope, 'portfolio_item', p.id, 'approved');
      await scope.db
        .updateTable('organization.portfolio_items')
        .set({ status: 'published', moderation_status: 'approved', published_at: sql<Date>`now()` })
        .where('id', '=', p.id)
        .execute();
      await publishEvent(scope, {
        type: 'portfolio.published',
        aggregateType: 'portfolio_item',
        aggregateId: p.id,
        payload: { organization_id: p.provider_organization_id, service_system_node_id: p.service_system_node_id },
      });
      return true;
    }
    if (action === 'hide' || action === 'remove' || action === 'request_changes') {
      if (!['pending_review', 'published'].includes(p.status)) return false;
      // Rejected items go back to the provider; request_changes leaves them editable as drafts.
      await scope.db
        .updateTable('organization.portfolio_items')
        .set({
          status: action === 'request_changes' ? 'draft' : 'rejected',
          moderation_status: action === 'request_changes' ? 'pending' : 'rejected',
          published_at: null,
        })
        .where('id', '=', p.id)
        .execute();
      if (action !== 'request_changes') await this.media?.moderateAttached(scope, 'portfolio_item', p.id, 'rejected');
      await publishEvent(scope, {
        type: 'organization.profile.updated',
        aggregateType: 'organization',
        aggregateId: p.provider_organization_id,
        payload: { organization_id: p.provider_organization_id, change: 'profile' },
      });
      return true;
    }
    if (action === 'restore') {
      if (p.status !== 'rejected') return false;
      await scope.db
        .updateTable('organization.portfolio_items')
        .set({ status: 'pending_review', moderation_status: 'pending' })
        .where('id', '=', p.id)
        .execute();
      return true;
    }
    return false;
  }

  onModuleInit(): void {
    this.gauges?.register('gauge.providers_published', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM organization.provider_profiles WHERE public_status = 'published' AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    this.gauges?.register('gauge.vendors_published', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM organization.vendor_profiles WHERE public_status = 'published' AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    this.gauges?.register('gauge.fleets_active', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM organization.organizations WHERE organization_type = 'fleet' AND status = 'active' AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    // admin.taxonomy_merge: showcase references follow a merged node (catalog rows with unique keys keep the old id and resolve through canonicalId).
    this.taxonomyRefs?.register('organization', (scope, from, into) =>
      repointColumns(
        scope,
        [
          ['organization.portfolio_items', 'brand_node_id'],
          ['organization.portfolio_items', 'model_node_id'],
          ['organization.portfolio_items', 'series_node_id'],
          ['organization.portfolio_items', 'service_system_node_id'],
          ['organization.portfolio_items', 'service_task_node_id'],
        ],
        from,
        into,
      ),
    );
    this.purposes?.register('verification', {
      open: async (scope, staffUserId, id) => {
        const v = await scope.db
          .selectFrom('organization.organization_verifications')
          .select(['status', 'reviewed_by'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return !!v && v.status === 'pending' && (v.reviewed_by === null || v.reviewed_by === staffUserId);
      },
      // S14 (BR-09): the organization, the member who submitted the check and the documents it submitted.
      subjects: async (scope, id) => {
        const v = await scope.db
          .selectFrom('organization.organization_verifications')
          .select(['organization_id', 'created_by', 'submitted_document_ids'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!v) return [];
        return [
          { type: 'organization', id: v.organization_id },
          ...(v.created_by ? [{ type: 'user', id: v.created_by }] : []),
          ...v.submitted_document_ids.map((m) => ({ type: 'media_asset', id: m })),
        ];
      },
    });
    this.executors?.register('admin.org_merge', async (scope, c) =>
      mergeOrganization(scope, this.authorizer, c.targetId, String(c.payload.into_organization_id), c.reason),
    );

    // The org_cards definer: reporters (users) see any organization's card, not its row.
    const orgExists = async (scope: TxScope, id: string) => {
      const card = (await this.cards.cards(scope, [id])).get(id);
      return !!card && card.status !== 'merged';
    };
    this.targets?.register('organization', {
      exists: orgExists,
      snapshot: async (scope, id) => {
        const o = await scope.db.selectFrom('organization.organizations').selectAll().where('id', '=', id).executeTakeFirst();
        return o
          ? {
              type: 'organization',
              id: o.id,
              available: true,
              name: o.name,
              organization_type: o.organization_type,
              slug: o.slug,
              status: o.status,
              verification_status: o.verification_status,
              trust_score: o.trust_score,
              created_at: o.created_at.toISOString(),
            }
          : null;
      },
      // S18 (BR-27): the organization's name (public on its page).
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('organization.organizations')
              .select(['id', 'name'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: excerpt(r.name), rating: null }]));
      },
      subjectOrganization: async (_scope, id) => id,
    });
    this.targets?.register('organization_location', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('organization.organization_locations')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const l = await scope.db.selectFrom('organization.organization_locations').selectAll().where('id', '=', id).executeTakeFirst();
        return l
          ? {
              type: 'organization_location',
              id: l.id,
              available: true,
              organization_id: l.organization_id,
              city: l.city,
              region: l.region,
              country: l.country,
              public_point: { lat: Number(l.public_latitude), lng: Number(l.public_longitude) },
              geo_source: l.geo_source,
              location_check_status: l.location_check_status,
              status: l.status,
            }
          : null;
      },
      // S18 (BR-27): the public town of the location (never the street address).
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('organization.organization_locations')
              .select(['id', 'city', 'country'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: excerpt(`${r.city}, ${r.country}`), rating: null }]));
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('organization.organization_locations').select('organization_id').where('id', '=', id).executeTakeFirst())
          ?.organization_id ?? null,
    });
    this.targets?.register('portfolio_item', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('organization.portfolio_items')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id, locale) => {
        const p = await scope.db.selectFrom('organization.portfolio_items').selectAll().where('id', '=', id).executeTakeFirst();
        if (!p) return null;
        // S18 (BR-33, A-CON-02): the consent record behind the showcase and the media to review.
        const media = (await this.media?.attachmentViews(scope, 'portfolio_item', [p.id]))?.get(p.id) ?? [];
        return {
          type: 'portfolio_item',
          id: p.id,
          available: true,
          provider_organization_id: p.provider_organization_id,
          title: p.title,
          description: p.description,
          caption: p.caption,
          status: p.status,
          moderation_status: p.moderation_status,
          visibility: p.visibility,
          customer_consent_status: p.customer_consent_status,
          consent: await this.showcaseConsent(scope, p.consent_reference_id, locale),
          media_ids: [...new Set(media.map((m) => m.media_asset_id))].slice(0, 40),
          created_at: p.created_at.toISOString(),
        };
      },
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('organization.portfolio_items')
              .select(['id', 'title'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: excerpt(r.title), rating: null }]));
      },
      subjectOrganization: async (scope, id) =>
        (
          await scope.db
            .selectFrom('organization.portfolio_items')
            .select('provider_organization_id')
            .where('id', '=', id)
            .executeTakeFirst()
        )?.provider_organization_id ?? null,
      apply: (scope, id, action) => this.portfolio(scope, id, action),
      pending: async (scope, limit) =>
        (
          await scope.db
            .selectFrom('organization.portfolio_items')
            .select('id')
            .where('status', '=', 'pending_review')
            .where('deleted_at', 'is', null)
            .orderBy('id')
            .limit(limit)
            .execute()
        ).map((r) => r.id),
    });

    this.personal?.register('organization', {
      async export(scope, userId) {
        const notes = await scope.db
          .selectFrom('organization.provider_customer_notes')
          .select(['id', 'provider_organization_id', 'body', 'status', 'created_at'])
          .where('customer_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        return [
          {
            section: 'provider_notes_about_you',
            records: notes.map((n) => ({
              id: n.id,
              fields: {
                provider_organization_id: n.provider_organization_id,
                body: n.body,
                status: n.status,
                created_at: n.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        const r = await sql`DELETE FROM organization.provider_customer_notes WHERE customer_user_id = ${userId}::uuid`.execute(scope.db);
        return Number(r.numAffectedRows ?? 0);
      },
    });
  }
}
