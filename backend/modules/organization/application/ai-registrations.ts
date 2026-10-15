// The organization module's parts of the AI facade (S9; 40 ai.profile_helper,
// ai.showcase_compose; 54 §2.2): context packages of the provider's own job
// logs, profile gaps and portfolio items (counts, ids and the item's own
// title; never customer data), and the sink that turns capability and coverage
// suggestions into source ai_suggested rows waiting for provider.gated_decide
// (status pending_provider_approval: not public, not counted).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { isLocale } from '#libs/i18n/index.js';
import { AiContextSources } from '#modules/ai-mcp/interface/ai.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';

type CapabilityRow = {
  service_system_node_id: string;
  service_task_node_id: string | null;
  brand_node_id: string | null;
  experience_level: string;
};
type CoverageRow = { brand_node_id: string; model_node_id: string | null };

@Injectable()
export class OrganizationAiRegistrations implements OnModuleInit {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
    @Optional() private readonly sources?: AiContextSources,
  ) {}

  onModuleInit(): void {
    this.sources?.register('provider.profile_facts', async (scope, who) => {
      if (!who.orgId) return null;
      const profile = await scope.db
        .selectFrom('organization.provider_profiles')
        .select(['id', 'description_translations'])
        .where('organization_id', '=', who.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!profile) return null;
      const logs = scope.db
        .selectFrom('organization.provider_job_logs')
        .where('provider_organization_id', '=', who.orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null);
      const jobSystems = await logs
        .select(['service_system_node_id', 'service_task_node_id', 'brand_node_id', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy(['service_system_node_id', 'service_task_node_id', 'brand_node_id'])
        .orderBy('count', 'desc')
        .limit(50)
        .execute();
      const jobBrands = await logs
        .select(['brand_node_id', 'model_node_id', (eb) => eb.fn.countAll<string>().as('count')])
        .where('brand_node_id', 'is not', null)
        .groupBy(['brand_node_id', 'model_node_id'])
        .orderBy('count', 'desc')
        .limit(50)
        .execute();
      const evidence = await logs.select('id').orderBy('job_date', 'desc').limit(50).execute();
      const counts = await sql<{ categories: string; portfolio: string; coverage: string }>`
        SELECT (SELECT count(*) FROM organization.provider_service_categories WHERE provider_organization_id = ${who.orgId}::uuid AND deleted_at IS NULL) AS categories,
               (SELECT count(*) FROM organization.portfolio_items WHERE provider_organization_id = ${who.orgId}::uuid AND deleted_at IS NULL) AS portfolio,
               (SELECT count(*) FROM organization.provider_vehicle_coverage WHERE provider_organization_id = ${who.orgId}::uuid AND deleted_at IS NULL) AS coverage`.execute(
        scope.db,
      );
      const c = counts.rows[0]!;
      const gaps = [
        ...(profile.description_translations ? [] : ['description']),
        ...(Number(c.categories) ? [] : ['service_categories']),
        ...(Number(c.portfolio) ? [] : ['portfolio']),
        ...(Number(c.coverage) ? [] : ['coverage']),
      ];
      return {
        job_systems: jobSystems.map((j) => ({ ...j, count: Number(j.count) })),
        job_brands: jobBrands.map((j) => ({ ...j, count: Number(j.count) })),
        // Without job logs the profile itself is the evidence of a profile-gap suggestion (52 AiInsight.evidence_references).
        evidence_job_log_ids: evidence.length ? evidence.map((e) => e.id) : [],
        evidence_profile_id: profile.id,
        profile_gaps: gaps,
      };
    });

    this.sources?.register('provider.portfolio_item', async (scope, who, args) => {
      if (!who.orgId || typeof args.item_id !== 'string') return null;
      const item = await scope.db
        .selectFrom('organization.portfolio_items')
        .select(['id', 'title', 'brand_node_id', 'model_node_id', 'service_system_node_id', 'service_task_node_id', 'status'])
        .where('id', '=', args.item_id)
        .where('provider_organization_id', '=', who.orgId)
        .where('status', '<>', 'archived')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!item) return null;
      const locale = isLocale(args.locale) ? args.locale : 'en';
      const nodeIds = [item.brand_node_id, item.model_node_id, item.service_system_node_id, item.service_task_node_id].filter(
        (x): x is string => !!x,
      );
      const labels = await this.taxonomy.labels(nodeIds, locale);
      const media = (await this.media.attachedAssets(scope, 'portfolio_item', item.id)).filter((m) => m.ready);
      return {
        title: item.title,
        labels: nodeIds.map((id) => labels.get(id)?.text).filter((x): x is string => !!x),
        media_count: media.length,
        image_media_ids: media.map((m) => m.assetId).slice(0, 20),
      };
    });

    this.sources?.registerSink('provider.capability_suggestions', async (scope, who, insightId, payload) => {
      if (!who.orgId) return 0;
      const caps = (payload.capabilities as CapabilityRow[] | undefined) ?? [];
      const coverage = (payload.coverage as CoverageRow[] | undefined) ?? [];
      let n = 0;
      if (caps.length)
        n += (
          await scope.db
            .insertInto('organization.provider_capabilities')
            .values(
              caps.map((c) => ({
                provider_organization_id: who.orgId!,
                brand_node_id: c.brand_node_id,
                service_system_node_id: c.service_system_node_id,
                service_task_node_id: c.service_task_node_id,
                experience_level: c.experience_level,
                source: 'ai_suggested',
                ai_insight_id: insightId,
                status: 'pending_provider_approval',
              })),
            )
            .onConflict((oc) => oc.doNothing())
            .returning('id')
            .execute()
        ).length;
      if (coverage.length)
        n += (
          await scope.db
            .insertInto('organization.provider_vehicle_coverage')
            .values(
              coverage.map((c) => ({
                provider_organization_id: who.orgId!,
                brand_node_id: c.brand_node_id,
                model_node_id: c.model_node_id,
                coverage_level: 'basic',
                source: 'ai_suggested',
                ai_insight_id: insightId,
                status: 'pending_provider_approval',
              })),
            )
            .onConflict((oc) => oc.doNothing())
            .returning('id')
            .execute()
        ).length;
      return n;
    });
  }
}
