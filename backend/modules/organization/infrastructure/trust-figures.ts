// TrustFigures (interface/trust-figures.ts): the organization's evidence
// sources and the stores of 54 §10, in the worker's system context. Evidence
// rows follow organization.tg_evidence_immutable: inserted active, later only
// revoked.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { textArray } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import {
  TrustFigures,
  type CapabilityScore,
  type EvidenceItem,
  type EvidenceType,
  type JobLogVisit,
  type LinkedEvidence,
  type OrgTrustFacts,
} from '../interface/trust-figures.js';

const day = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/** 54 §1.1 weights of the evidence this module owns. */
const PORTFOLIO_WEIGHT = 5;
const JOB_LOG_WEIGHT = 3;
const CERTIFICATION_WEIGHT = 15;
const CAPABILITY_CERTIFICATIONS = ['manufacturer', 'industry', 'ev_high_voltage'];

const SOURCE_OF: Record<EvidenceType, 'job_evidence' | 'review_evidence' | 'certification'> = {
  completed_appointment: 'job_evidence',
  service_record: 'job_evidence',
  job_log: 'job_evidence',
  portfolio_item: 'job_evidence',
  verified_review: 'review_evidence',
  certification: 'certification',
};

type CapabilityRow = {
  id: string;
  brand_node_id: string | null;
  model_node_id: string | null;
  series_node_id: string | null;
  service_system_node_id: string;
  service_task_node_id: string | null;
};

/** Number of taxonomy fields a capability pins down (more = more specific). */
const specificity = (c: CapabilityRow) =>
  [c.brand_node_id, c.model_node_id, c.series_node_id, c.service_task_node_id].filter((x) => x !== null).length;

/** The capability fits the evidence when every field it pins equals the evidence's. */
function fits(c: CapabilityRow, e: EvidenceItem): boolean {
  if (e.serviceSystemNodeId === null || c.service_system_node_id !== e.serviceSystemNodeId) return false;
  const pairs: [string | null, string | null][] = [
    [c.brand_node_id, e.brandNodeId],
    [c.model_node_id, e.modelNodeId],
    [c.series_node_id, e.seriesNodeId],
    [c.service_task_node_id, e.serviceTaskNodeId],
  ];
  return pairs.every(([cap, ev]) => cap === null || cap === ev);
}

const key = (capabilityId: string, refType: string, refId: string) => `${capabilityId}|${refType}|${refId}`;

@Injectable()
export class DbTrustFigures extends TrustFigures {
  constructor(private readonly taxonomy: TaxonomyResolver) {
    super();
  }

  async jobLog(scope: TxScope, orgId: string, jobLogId: string): Promise<JobLogVisit | null> {
    const j = await scope.db
      .selectFrom('organization.provider_job_logs')
      .select(['id', 'vehicle_id', 'job_date', 'service_system_node_id', 'service_task_node_id'])
      .where('id', '=', jobLogId)
      .where('provider_organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return j
      ? {
          id: j.id,
          vehicleId: j.vehicle_id,
          jobDate: day(j.job_date),
          serviceSystemNodeId: j.service_system_node_id,
          serviceTaskNodeId: j.service_task_node_id,
        }
      : null;
  }

  async facts(scope: TxScope, orgId: string): Promise<OrgTrustFacts | null> {
    const o = await scope.db
      .selectFrom('organization.organizations')
      .select(['id', 'organization_type', 'status', 'verification_status', 'trust_score', 'created_at'])
      .where('id', '=', orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!o) return null;
    const [verifications, provider, vendor, locations, certifications] = await Promise.all([
      scope.db
        .selectFrom('organization.organization_verifications')
        .select('verification_type')
        .where('organization_id', '=', orgId)
        .where('status', '=', 'verified')
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
        .execute(),
      scope.db
        .selectFrom('organization.provider_profiles')
        .select(['profile_completeness', 'activity_status', 'public_status', 'created_at'])
        .where('organization_id', '=', orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      scope.db
        .selectFrom('organization.vendor_profiles')
        .select(['profile_completeness', 'catalog_quality_score', 'measured_response_time_minutes', 'public_status'])
        .where('organization_id', '=', orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      scope.db
        .selectFrom('organization.organization_locations')
        .select(['location_verified_at'])
        .where('organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute(),
      scope.db
        .selectFrom('organization.provider_certifications')
        .select(['id', 'certification_type', 'verification_status', 'scope_node_ids', 'expires_at'])
        .where('provider_organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    const today = day(new Date());
    return {
      orgId: o.id,
      organizationType: o.organization_type,
      status: o.status,
      verificationStatus: o.verification_status,
      trustScore: o.trust_score === null ? null : Number(o.trust_score),
      createdAt: new Date(o.created_at),
      verifiedTypes: [...new Set(verifications.map((v) => v.verification_type))],
      provider: provider
        ? {
            profileCompleteness: Number(provider.profile_completeness),
            activityStatus: provider.activity_status,
            publicStatus: provider.public_status,
            createdAt: new Date(provider.created_at),
          }
        : null,
      vendor: vendor
        ? {
            profileCompleteness: Number(vendor.profile_completeness),
            catalogQualityScore: Number(vendor.catalog_quality_score),
            measuredResponseTimeMinutes: vendor.measured_response_time_minutes,
            publicStatus: vendor.public_status,
          }
        : null,
      activeLocations: locations.length,
      verifiedLocations: locations.filter((l) => l.location_verified_at !== null).length,
      certifications: certifications
        .filter((c) => c.expires_at === null || day(c.expires_at) >= today)
        .map((c) => ({
          id: c.id,
          type: c.certification_type,
          verified: c.verification_status === 'verified',
          scopeNodeIds: textArray(c.scope_node_ids),
          expiresAt: c.expires_at === null ? null : day(c.expires_at),
        })),
    };
  }

  async ownEvidence(scope: TxScope, orgId: string): Promise<EvidenceItem[]> {
    const [portfolio, jobs, certs] = await Promise.all([
      scope.db
        .selectFrom('organization.portfolio_items')
        .select([
          'id',
          'brand_node_id',
          'model_node_id',
          'series_node_id',
          'service_system_node_id',
          'service_task_node_id',
          'job_date',
          'published_at',
        ])
        .where('provider_organization_id', '=', orgId)
        .where('status', '=', 'published')
        .where('moderation_status', '=', 'approved')
        .where('customer_consent_status', 'in', ['not_required', 'granted'])
        .where('deleted_at', 'is', null)
        .execute(),
      scope.db
        .selectFrom('organization.provider_job_logs')
        .select([
          'id',
          'brand_node_id',
          'model_node_id',
          'series_node_id',
          'service_system_node_id',
          'service_task_node_id',
          'job_date',
          'appointment_id',
          'service_record_id',
        ])
        .where('provider_organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('verification_status', '<>', 'self_reported')
        .where('deleted_at', 'is', null)
        .execute(),
      scope.db
        .selectFrom('organization.provider_certifications')
        .select(['id', 'certification_type', 'scope_node_ids', 'issued_at', 'created_at', 'expires_at'])
        .where('provider_organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('verification_status', '=', 'verified')
        .where('certification_type', 'in', CAPABILITY_CERTIFICATIONS)
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    const items: EvidenceItem[] = [];
    for (const p of portfolio)
      items.push({
        evidenceType: 'portfolio_item',
        referenceType: 'portfolio_item',
        referenceId: p.id,
        baseWeight: PORTFOLIO_WEIGHT,
        evidenceDate: day(p.job_date ?? p.published_at ?? new Date()),
        brandNodeId: p.brand_node_id,
        modelNodeId: p.model_node_id,
        seriesNodeId: p.series_node_id,
        serviceSystemNodeId: p.service_system_node_id,
        serviceTaskNodeId: p.service_task_node_id,
      });
    for (const j of jobs)
      items.push({
        evidenceType: 'job_log',
        referenceType: 'job_log',
        referenceId: j.id,
        baseWeight: JOB_LOG_WEIGHT,
        evidenceDate: day(j.job_date),
        brandNodeId: j.brand_node_id,
        modelNodeId: j.model_node_id,
        seriesNodeId: j.series_node_id,
        serviceSystemNodeId: j.service_system_node_id,
        serviceTaskNodeId: j.service_task_node_id,
        sameJobAs: [j.appointment_id, j.service_record_id].filter((x): x is string => !!x),
      });
    const today = day(new Date());
    for (const c of certs) {
      if (c.expires_at !== null && day(c.expires_at) < today) continue;
      // Scope nodes: brands and service systems (54 §1.1 "brand and/or service system from scope_node_ids").
      let brand: string | null = null;
      const systems: string[] = [];
      for (const id of textArray(c.scope_node_ids)) {
        const node = await this.taxonomy.get(id);
        if (node?.type === 'vehicle_brand') brand ??= node.id;
        else if (node?.type === 'service_system') systems.push(node.id);
      }
      const base = {
        evidenceType: 'certification' as const,
        referenceType: 'certification' as const,
        referenceId: c.id,
        baseWeight: CERTIFICATION_WEIGHT,
        evidenceDate: day(c.issued_at ?? c.created_at),
        brandNodeId: brand,
        modelNodeId: null,
        seriesNodeId: null,
        serviceTaskNodeId: null,
      };
      if (systems.length === 0 && brand) items.push({ ...base, serviceSystemNodeId: null });
      for (const s of systems) items.push({ ...base, serviceSystemNodeId: s });
    }
    return items;
  }

  async syncEvidence(scope: TxScope, orgId: string, items: readonly EvidenceItem[]): Promise<LinkedEvidence[]> {
    const capabilities: CapabilityRow[] = await scope.db
      .selectFrom('organization.provider_capabilities')
      .select(['id', 'brand_node_id', 'model_node_id', 'series_node_id', 'service_system_node_id', 'service_task_node_id'])
      .where('provider_organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .execute();
    const existing = await scope.db
      .selectFrom('organization.provider_capability_evidence as e')
      .innerJoin('organization.provider_capabilities as c', 'c.id', 'e.capability_id')
      .select(['e.id', 'e.capability_id', 'e.reference_entity_type', 'e.reference_entity_id', 'e.status', 'e.linked_by'])
      .where('c.provider_organization_id', '=', orgId)
      .where('e.deleted_at', 'is', null)
      .execute();
    const byKey = new Map(existing.map((e) => [key(e.capability_id, e.reference_entity_type, e.reference_entity_id), e]));

    // Capabilities each item links to (54 §1: one capability; certifications every matching one).
    const wanted = new Map<string, { item: EvidenceItem; capabilityId: string }>();
    for (const item of items) {
      let targets: CapabilityRow[];
      if (item.evidenceType === 'certification') {
        targets = capabilities.filter((c) =>
          item.serviceSystemNodeId
            ? c.service_system_node_id === item.serviceSystemNodeId && (item.brandNodeId === null || c.brand_node_id === item.brandNodeId)
            : c.brand_node_id === item.brandNodeId,
        );
      } else {
        const best = capabilities.filter((c) => fits(c, item)).sort((a, b) => specificity(b) - specificity(a))[0];
        targets = best ? [best] : [];
      }
      if (targets.length === 0 && item.serviceSystemNodeId) {
        // No capability for this system yet: a system-level one, not public until the provider shows it.
        const created = await scope.db
          .insertInto('organization.provider_capabilities')
          .values({
            provider_organization_id: orgId,
            service_system_node_id: item.serviceSystemNodeId,
            experience_level: 'intermediate',
            source: SOURCE_OF[item.evidenceType],
            public_visibility: false,
            status: 'active',
          })
          .onConflict((oc) => oc.doNothing())
          .returning(['id', 'brand_node_id', 'model_node_id', 'series_node_id', 'service_system_node_id', 'service_task_node_id'])
          .executeTakeFirst();
        const row =
          created ??
          (await scope.db
            .selectFrom('organization.provider_capabilities')
            .select(['id', 'brand_node_id', 'model_node_id', 'series_node_id', 'service_system_node_id', 'service_task_node_id'])
            .where('provider_organization_id', '=', orgId)
            .where('service_system_node_id', '=', item.serviceSystemNodeId)
            .where('brand_node_id', 'is', null)
            .where('model_node_id', 'is', null)
            .where('series_node_id', 'is', null)
            .where('service_task_node_id', 'is', null)
            .executeTakeFirst());
        // An inactive or rejected system-level capability blocks the link: the provider removed that claim.
        if (row && capabilities.every((c) => c.id !== row.id)) {
          const active = await scope.db
            .selectFrom('organization.provider_capabilities')
            .select('status')
            .where('id', '=', row.id)
            .executeTakeFirst();
          if (active?.status === 'active') capabilities.push(row);
          else continue;
        }
        targets = row ? [row] : [];
      }
      for (const t of targets) wanted.set(key(t.id, item.referenceType, item.referenceId), { item, capabilityId: t.id });
    }

    const out: LinkedEvidence[] = [];
    for (const [k, w] of wanted) {
      const row = byKey.get(k);
      if (row) {
        // A revoked row stays revoked (54 §9); pending AI links are decided by the provider, not here.
        if (row.status === 'active') out.push({ ...w.item, id: row.id, capabilityId: w.capabilityId });
        continue;
      }
      const inserted = await scope.db
        .insertInto('organization.provider_capability_evidence')
        .values({
          capability_id: w.capabilityId,
          evidence_type: w.item.evidenceType,
          reference_entity_type: w.item.referenceType,
          reference_entity_id: w.item.referenceId,
          base_weight: Math.max(-100, Math.min(100, Math.round(w.item.baseWeight))),
          evidence_date: w.item.evidenceDate,
          linked_by: 'system_rule',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      out.push({ ...w.item, id: inserted.id, capabilityId: w.capabilityId });
    }
    const revoke = existing.filter(
      (e) =>
        e.status === 'active' &&
        e.linked_by === 'system_rule' &&
        !wanted.has(key(e.capability_id, e.reference_entity_type, e.reference_entity_id)),
    );
    if (revoke.length)
      await scope.db
        .updateTable('organization.provider_capability_evidence')
        .set({ status: 'revoked' })
        .where(
          'id',
          'in',
          revoke.map((e) => e.id),
        )
        .execute();
    return out;
  }

  async recordCapabilityScores(scope: TxScope, orgId: string, scores: readonly CapabilityScore[]): Promise<number> {
    let n = 0;
    for (const s of scores) {
      const score = Math.round(s.confidenceScore * 100) / 100;
      const r = await scope.db
        .updateTable('organization.provider_capabilities')
        .set({
          confidence_level: s.confidenceLevel,
          confidence_score: String(score),
          evidence_count: s.evidenceCount,
          badge_eligible: s.badgeEligible,
        })
        .where('id', '=', s.capabilityId)
        .where('provider_organization_id', '=', orgId)
        .where((eb) =>
          eb.or([
            eb('confidence_level', '<>', s.confidenceLevel),
            eb('confidence_score', '<>', String(score)),
            eb('evidence_count', '<>', s.evidenceCount),
            eb('badge_eligible', '<>', s.badgeEligible),
          ]),
        )
        .executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    return n;
  }

  async recordTrustScore(scope: TxScope, orgId: string, score: number | null): Promise<{ changed: boolean; previous: number | null }> {
    const row = await scope.db
      .selectFrom('organization.organizations')
      .select('trust_score')
      .where('id', '=', orgId)
      .forUpdate()
      .executeTakeFirst();
    const previous = row?.trust_score === null || row?.trust_score === undefined ? null : Number(row.trust_score);
    const next = score === null ? null : Math.max(0, Math.min(100, Math.round(score)));
    if (!row || previous === next) return { changed: false, previous };
    await scope.db.updateTable('organization.organizations').set({ trust_score: next }).where('id', '=', orgId).execute();
    return { changed: true, previous };
  }

  async recordProviderFigures(
    scope: TxScope,
    orgId: string,
    f: { activityStatus?: 'active' | 'inactive'; measuredResponseTimeMinutes?: number | null },
  ): Promise<boolean> {
    const set: { activity_status?: 'active' | 'inactive'; measured_response_time_minutes?: number | null } = {};
    if (f.activityStatus !== undefined) set.activity_status = f.activityStatus;
    if (f.measuredResponseTimeMinutes !== undefined)
      set.measured_response_time_minutes =
        f.measuredResponseTimeMinutes === null ? null : Math.max(0, Math.round(f.measuredResponseTimeMinutes));
    if (Object.keys(set).length === 0) return false;
    const r = await scope.db
      .updateTable('organization.provider_profiles')
      .set(set)
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          ...(set.activity_status !== undefined ? [eb('activity_status', 'is distinct from', set.activity_status)] : []),
          ...(set.measured_response_time_minutes !== undefined
            ? [eb('measured_response_time_minutes', 'is distinct from', set.measured_response_time_minutes)]
            : []),
        ]),
      )
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
}
