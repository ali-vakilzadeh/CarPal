// Help Me matches (40 triage.complete find_providers, interface
// TriageMatching): the triage's symptom and likely systems become the edited
// chips of a provider search, ranked by the same rules as search.run (54 §3),
// stored as a match session with source ai_triage and entry point help_me.
// The AI never ranks: it only proposed the systems the user saw.
import { Injectable } from '@nestjs/common';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { TriageMatching, type TriageMatchInput } from '../interface/match-results.js';
import { SearchService, type IntentChip, type LocationInput } from './search-service.js';

@Injectable()
export class SearchTriageMatching extends TriageMatching {
  constructor(
    private readonly search: SearchService,
    private readonly taxonomy: TaxonomyResolver,
  ) {
    super();
  }

  async match(ctx: OperationContext, scope: TxScope, i: TriageMatchInput) {
    const systems = i.serviceSystemNodeIds.slice(0, 3);
    const ids = [...(i.symptomNodeId ? [i.symptomNodeId] : []), ...systems, ...(i.serviceTaskNodeId ? [i.serviceTaskNodeId] : [])];
    const labels = await this.taxonomy.labels(ids, ctx.locale);
    const chip = (kind: IntentChip['kind'], id: string): IntentChip[] =>
      labels.has(id) ? [{ kind, node_id: id, label: labels.get(id)!, removable: true }] : [];
    const chips = [
      ...(i.symptomNodeId ? chip('symptom', i.symptomNodeId) : []),
      ...systems.flatMap((s) => chip('service_system', s)),
      ...(i.serviceTaskNodeId ? chip('service_task', i.serviceTaskNodeId) : []),
    ];
    const r = await this.search.runIn(
      ctx,
      scope,
      {
        search_mode: 'providers',
        entry_point: 'help_me',
        vehicle_id: i.vehicleId,
        ...(i.fleetId ? { as_organization_id: i.fleetId } : {}),
        location: i.location as unknown as LocationInput,
        ...(i.urgency ? { urgency_level: i.urgency } : {}),
        intent_override: { target_type: 'provider', chips },
      },
      { source: 'ai_triage', triageSessionId: i.triageSessionId, issueId: i.issueId },
    );
    const rows = await scope.db
      .selectFrom('discovery.match_results')
      .select(['id', 'target_entity_id'])
      .where('match_session_id', '=', r.session_id)
      .where('target_entity_type', '=', 'organization')
      .execute();
    return { matchSessionId: r.session_id, resultIds: new Map(rows.map((x) => [x.target_entity_id, x.id])) };
  }
}
