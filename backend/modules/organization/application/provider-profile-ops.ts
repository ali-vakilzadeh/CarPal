// Provider profile, publication, certifications and insights (40 §8.2):
// provider.profile_get / profile_put / publish / unpublish,
// provider.certifications_list / certification_create / update / delete,
// provider.insights_get.
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toCertification, toProviderProfile, type CertificationRow, type ProviderProfileRow } from '../api/projections.js';
import {
  completeness,
  defaultSlug,
  insightsPeriod,
  isFutureDate,
  PROVIDER_COMPLETENESS,
  providerPublishUnmet,
} from '../domain/profile-rules.js';
import { OrganizationExtensions } from '../interface/extensions.js';
import { ProfileFacts } from '../infrastructure/facts.js';
import { afterId, checkNodes, checkVersion, failIf, json, member, pageOf, profileUpdated, publicationChanged } from './common.js';

type ContactChannel = { type: 'phone' | 'email' | 'whatsapp' | 'website'; value: string; preferred: boolean };
type ProviderProfileWrite = {
  provider_type: string;
  description_translations?: Record<string, string>;
  years_in_business?: number;
  languages_spoken?: string[];
  amenity_node_ids?: string[];
  service_modes: string[];
  contact_channels?: ContactChannel[];
  price_tier: string;
  warranty_offered: boolean;
  warranty_policy_translations?: Record<string, string>;
  response_time_target?: string;
};

const CHANNEL_PATTERNS: Record<ContactChannel['type'], RegExp> = {
  phone: /^\+[1-9]\d{6,14}$/,
  whatsapp: /^\+[1-9]\d{6,14}$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  website: /^https:\/\/[^\s@#/?]+([/?][^\s#]*)?$/,
};

/** Public contact channels (SEC-OUT-3: the only contact data shown publicly): value shape per type, one preferred at most. */
export function checkChannels(channels: ContactChannel[] | undefined): FieldError[] {
  const errors: FieldError[] = [];
  (channels ?? []).forEach((c, i) => {
    if (!CHANNEL_PATTERNS[c.type].test(c.value)) errors.push({ pointer: `/contact_channels/${i}/value`, code: 'pattern' });
  });
  if ((channels ?? []).filter((c) => c.preferred).length > 1) errors.push({ pointer: '/contact_channels', code: 'not_unique' });
  return errors;
}

async function loadProfile(scope: TxScope, orgId: string, lock = false): Promise<ProviderProfileRow | undefined> {
  const q = scope.db
    .selectFrom('organization.provider_profiles')
    .selectAll()
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

@Injectable()
@Operation('provider.profile_get')
export class ProviderProfileGetHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const p = await loadProfile(scope, m.orgId);
        if (!p) throw new ApiError('NOT_FOUND');
        const c = completeness(PROVIDER_COMPLETENESS, await this.facts.provider(scope, m.orgId));
        return toProviderProfile(p, { completeness: c.score, gaps: c.gaps });
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('provider.profile_put')
export class ProviderProfilePutHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext<ProviderProfileWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const errors = checkChannels(b.contact_channels);
    if (b.warranty_offered && !b.warranty_policy_translations)
      errors.push({ pointer: '/warranty_policy_translations', code: 'conditional_required' });
    failIf(errors);
    const body = await ctx.tx(async (scope) => {
      const existing = await loadProfile(scope, m.orgId, true);
      // ETAG(if exists) IDEM(if new): replacing needs If-Match; creating needs Idempotency-Key (pipeline).
      if (existing) checkVersion(existing.version, ctx.ifMatch);
      else if (ctx.ifMatch !== undefined) throw new ApiError('VERSION_MISMATCH', { detail: 'no profile yet' });
      // Completeness of the profile as written (one write, so a new profile is version 1).
      const facts = await this.facts.provider(scope, m.orgId);
      const c = completeness(PROVIDER_COMPLETENESS, {
        ...facts,
        hasProfile: true,
        descriptionSet: !!b.description_translations,
        contactChannels: b.contact_channels?.length ?? 0,
      });
      const values = {
        provider_type: b.provider_type,
        description_translations: json(b.description_translations),
        years_in_business: b.years_in_business ?? null,
        languages_spoken: b.languages_spoken ?? [],
        amenity_node_ids: b.amenity_node_ids ?? [],
        service_modes: b.service_modes,
        contact_channels: JSON.stringify(b.contact_channels ?? []),
        price_tier: b.price_tier,
        warranty_offered: b.warranty_offered,
        warranty_policy_translations: json(b.warranty_policy_translations),
        response_time_target: b.response_time_target ?? null,
        profile_completeness: c.score,
      };
      const row = existing
        ? await scope.db
            .updateTable('organization.provider_profiles')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await scope.db
            .insertInto('organization.provider_profiles')
            .values({ ...values, organization_id: m.orgId })
            .returningAll()
            .executeTakeFirstOrThrow();
      await profileUpdated(scope, m.orgId, 'profile');
      return toProviderProfile(row, { completeness: c.score, gaps: c.gaps });
    });
    return { body };
  }
}

/**
 * A draft organization goes live with its first published profile (DI-18).
 * A published organization without a slug gets its default slug (S9b), so
 * its public profile is reachable through public.org_get.
 */
export async function activateOrganization(scope: TxScope, orgId: string): Promise<boolean> {
  const org = await scope.db.selectFrom('organization.organizations').select(['name', 'slug']).where('id', '=', orgId).executeTakeFirst();
  if (org && !org.slug)
    await scope.db
      .updateTable('organization.organizations')
      .set({ slug: defaultSlug(org.name, orgId) })
      .where('id', '=', orgId)
      .execute();
  const r = await scope.db
    .updateTable('organization.organizations')
    .set({ status: 'active' })
    .where('id', '=', orgId)
    .where('status', '=', 'draft')
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

@Injectable()
@Operation('provider.publish')
export class ProviderPublishHandler implements OperationHandler {
  constructor(
    private readonly facts: ProfileFacts,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const profile = await loadProfile(scope, m.orgId, true);
      const facts = await this.facts.provider(scope, m.orgId);
      const unmet = providerPublishUnmet(facts);
      // 52 §21 / 56 §2.10: the problem lists what is missing (Problem.requirements, DI-10).
      if (unmet.length || !profile)
        throw new ApiError('PUBLISH_REQUIREMENTS_UNMET', { detail: unmet.join(','), extensions: { requirements: unmet } });
      const score = completeness(PROVIDER_COMPLETENESS, facts).score;
      await scope.db
        .updateTable('organization.provider_profiles')
        .set({ public_status: 'published', profile_completeness: score })
        .where('id', '=', profile.id)
        .execute();
      const activated = await activateOrganization(scope, m.orgId);
      await publicationChanged(scope, m.orgId, 'provider', 'published', profile.id);
      await writeAudit(scope, {
        action: 'provider.published',
        entityType: 'provider_profile',
        entityId: profile.id,
        previous: profile.public_status,
        next: activated ? 'published; organization active' : 'published',
      });
      if (activated) scope.afterCommit(() => this.authorizer.invalidateOrganization(m.orgId));
      return { public_status: 'published', unmet: [] };
    });
    return { body };
  }
}

@Injectable()
@Operation('provider.unpublish')
export class ProviderUnpublishHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const profile = await loadProfile(scope, m.orgId, true);
      if (!profile) throw new ApiError('NOT_FOUND');
      // A suspension by staff stays in place; existing appointments continue either way.
      const next = profile.public_status === 'published' ? 'draft' : profile.public_status;
      if (next !== profile.public_status) {
        await scope.db.updateTable('organization.provider_profiles').set({ public_status: next }).where('id', '=', profile.id).execute();
        await publicationChanged(scope, m.orgId, 'provider', 'unpublished', profile.id);
      }
      await writeAudit(scope, {
        action: 'provider.unpublished',
        entityType: 'provider_profile',
        entityId: profile.id,
        reason: ctx.body.reason,
        previous: profile.public_status,
        next,
      });
      return { public_status: next, unmet: providerPublishUnmet(await this.facts.provider(scope, m.orgId)) };
    });
    return { body };
  }
}

// ------------------------------------------------------------ certifications

type CertificationWrite = {
  certification_type: string;
  name: string;
  issuer: string;
  credential_number?: string;
  scope_node_ids?: string[];
  issued_at?: string;
  expires_at?: string;
  document_media_asset_id?: string;
};

function checkCertificationDates(c: { issued_at?: string | null; expires_at?: string | null }): void {
  const errors: FieldError[] = [];
  if (c.issued_at && isFutureDate(c.issued_at)) errors.push({ pointer: '/issued_at', code: 'in_future' });
  if (c.issued_at && c.expires_at && c.expires_at <= c.issued_at) errors.push({ pointer: '/expires_at', code: 'order' });
  failIf(errors);
}

/** 52: a dated certificate past its expiry is expired; removed stays removed. */
const certStatus = (expiresAt: string | null | undefined): 'active' | 'expired' =>
  expiresAt && expiresAt < new Date().toISOString().slice(0, 10) ? 'expired' : 'active';

@Injectable()
export class CertificationRules {
  constructor(
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  /** Scope nodes are brands or service systems (52); a document must be the organization's clean certificate. */
  async check(scope: TxScope, orgId: string, c: { scope_node_ids?: string[]; document_media_asset_id?: string | null }): Promise<void> {
    await checkNodes(this.taxonomy, c.scope_node_ids, ['vehicle_brand', 'service_system'], '/scope_node_ids');
    if (c.document_media_asset_id)
      await this.media.requireReady(scope, [c.document_media_asset_id], {
        owner: { type: 'organization', id: orgId },
        purposes: ['certification_document'],
        pointer: '/document_media_asset_id',
      });
  }
}

async function loadCertification(scope: TxScope, orgId: string, id: string, lock = false): Promise<CertificationRow> {
  const q = scope.db
    .selectFrom('organization.provider_certifications')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('status', '<>', 'removed')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.certifications_list')
export class ProviderCertificationsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_certifications')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toCertification) };
  }
}

@Injectable()
@Operation('provider.certification_create')
export class ProviderCertificationCreateHandler implements OperationHandler {
  constructor(private readonly rules: CertificationRules) {}

  async handle(ctx: OperationContext<CertificationWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    checkCertificationDates(b);
    const row = await ctx.tx(async (scope) => {
      await this.rules.check(scope, m.orgId, b);
      return scope.db
        .insertInto('organization.provider_certifications')
        .values({
          provider_organization_id: m.orgId,
          certification_type: b.certification_type,
          name: b.name,
          issuer: b.issuer,
          credential_number: b.credential_number ?? null,
          scope_node_ids: b.scope_node_ids ?? [],
          issued_at: b.issued_at ?? null,
          expires_at: b.expires_at ?? null,
          document_media_asset_id: b.document_media_asset_id ?? null,
          // With a clean document it enters the admin verification queue (S8); without, it stays unverified.
          verification_status: b.document_media_asset_id ? 'pending' : 'unverified',
          status: certStatus(b.expires_at),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(toCertification(row), `/v1/orgs/${m.orgId}/provider/certifications/${row.id}`);
  }
}

@Injectable()
@Operation('provider.certification_update')
export class ProviderCertificationUpdateHandler implements OperationHandler {
  constructor(private readonly rules: CertificationRules) {}

  async handle(ctx: OperationContext<Partial<CertificationWrite>>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const c = await loadCertification(scope, m.orgId, ctx.params.certification_id!, true);
      checkVersion(c.version, ctx.ifMatch);
      const issued = b.issued_at !== undefined ? b.issued_at : c.issued_at;
      const expires = b.expires_at !== undefined ? b.expires_at : c.expires_at;
      checkCertificationDates({ issued_at: issued, expires_at: expires });
      await this.rules.check(scope, m.orgId, b);
      // Changing the document or the credential resets verification (40 provider.certification_update).
      const reset =
        (b.document_media_asset_id !== undefined && b.document_media_asset_id !== c.document_media_asset_id) ||
        (b.credential_number !== undefined && b.credential_number !== c.credential_number);
      const document = b.document_media_asset_id !== undefined ? b.document_media_asset_id : c.document_media_asset_id;
      return scope.db
        .updateTable('organization.provider_certifications')
        .set({
          ...(b.certification_type !== undefined ? { certification_type: b.certification_type } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.issuer !== undefined ? { issuer: b.issuer } : {}),
          ...(b.credential_number !== undefined ? { credential_number: b.credential_number } : {}),
          ...(b.scope_node_ids !== undefined ? { scope_node_ids: b.scope_node_ids } : {}),
          ...(b.issued_at !== undefined ? { issued_at: b.issued_at } : {}),
          ...(b.expires_at !== undefined ? { expires_at: b.expires_at } : {}),
          ...(b.document_media_asset_id !== undefined ? { document_media_asset_id: b.document_media_asset_id } : {}),
          ...(reset ? { verification_status: document ? 'pending' : 'unverified' } : {}),
          status: certStatus(expires),
        })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toCertification(row) };
  }
}

/** Revokes the capability evidence that cites a record (54 §9: evidence is revoked, never edited). */
export async function revokeEvidence(scope: TxScope, type: 'certification' | 'job_log' | 'portfolio_item', id: string): Promise<void> {
  await scope.db
    .updateTable('organization.provider_capability_evidence')
    .set({ status: 'revoked' })
    .where('reference_entity_type', '=', type)
    .where('reference_entity_id', '=', id)
    .where('status', '<>', 'revoked')
    .execute();
}

@Injectable()
@Operation('provider.certification_delete')
export class ProviderCertificationDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const c = await loadCertification(scope, m.orgId, ctx.params.certification_id!, true);
      await scope.db.updateTable('organization.provider_certifications').set({ status: 'removed' }).where('id', '=', c.id).execute();
      await revokeEvidence(scope, 'certification', c.id);
      await writeAudit(scope, { action: 'provider.certification_removed', entityType: 'provider_certification', entityId: c.id });
    });
    return { body: ACK };
  }
}

// ------------------------------------------------------------ insights

@Injectable()
@Operation('provider.insights_get')
export class ProviderInsightsGetHandler implements OperationHandler {
  constructor(
    private readonly facts: ProfileFacts,
    private readonly ext: OrganizationExtensions,
  ) {}

  async handle(ctx: OperationContext<undefined, { from: string; to: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const period = { from: ctx.query.from, to: ctx.query.to };
    failIf(insightsPeriod(period.from, period.to));
    const body = await ctx.tx(
      async (scope) => {
        const profile = await loadProfile(scope, m.orgId);
        const facts = await this.facts.provider(scope, m.orgId);
        const x = <T>(key: Parameters<OrganizationExtensions['insight']>[0], fallback: T) =>
          this.ext.insight(key, scope, m.orgId, period, fallback);
        // Figures of other modules (reviews S7, requests S7, views and taps S8 analytics) read 0/null until they register.
        return {
          period,
          profile_completeness: completeness(PROVIDER_COMPLETENESS, facts).score,
          measured_response_time_minutes: profile?.measured_response_time_minutes ?? null,
          overall_rating: await x<string | null>('provider.overall_rating', null),
          review_count: await x('provider.review_count', 0),
          category_ratings: await x<unknown[]>('provider.category_ratings', []),
          profile_views: await x('provider.profile_views', 0),
          map_pin_views: await x('provider.map_pin_views', 0),
          directions_taps: await x('provider.directions_taps', 0),
          requests_received: await x('provider.requests_received', 0),
          requests_from_map: await x('provider.requests_from_map', 0),
          completion_rate: await x<string | null>('provider.completion_rate', null),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}
