// ProviderCapabilities for discovery and trust scoring: active capability
// rows of providers in the caller's RLS context.
import { Injectable } from '@nestjs/common';
import type { TxScope } from '#libs/tenancy/index.js';
import { ProviderCapabilities, type CapabilityRecord } from '../interface/provider-capabilities.js';

@Injectable()
export class DbProviderCapabilities extends ProviderCapabilities {
  async forProviders(scope: TxScope, orgIds: readonly string[]): Promise<CapabilityRecord[]> {
    const ids = [...new Set(orgIds)].slice(0, 500);
    if (ids.length === 0) return [];
    const rows = await scope.db
      .selectFrom('organization.provider_capabilities')
      .selectAll()
      .where('provider_organization_id', 'in', ids)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      providerOrganizationId: r.provider_organization_id,
      brandNodeId: r.brand_node_id,
      modelNodeId: r.model_node_id,
      seriesNodeId: r.series_node_id,
      serviceSystemNodeId: r.service_system_node_id,
      serviceTaskNodeId: r.service_task_node_id,
      experienceLevel: r.experience_level,
      confidenceLevel: r.confidence_level,
      confidenceScore: Number(r.confidence_score),
      evidenceCount: r.evidence_count,
      publicVisibility: r.public_visibility,
      badgeEligible: r.badge_eligible,
    }));
  }
}
