// Discovery's parts of S8 platform flows: retention of match sessions (52
// DataRetentionPolicy MatchSession 180 d, anonymize: the query text and
// position leave, the ranking stays for metrics) and data subject requests (a
// user's search sessions are anonymized the same way on deletion), and the
// aggregated part demand AI inventory gaps read (S9: counts per part category
// over all searches of the last 30 days, worker system context; no query text,
// no requesters, no other vendor's data).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { retentionCutoff, RetentionHandlers } from '#modules/admin/interface/admin.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { AiContextSources } from '#modules/ai-mcp/interface/ai.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';

// The session keeps an unlinkable key (52 MatchSession needs a requester or an anonymous key).
const ANONYMIZE = sql`query_text = NULL, query_normalized = NULL, latitude = NULL, longitude = NULL, map_viewport = NULL,
                      requester_user_id = NULL, vehicle_id = NULL,
                      anonymous_key_hash = encode(sha256(convert_to(id::text || 'anonymized', 'UTF8')), 'hex')`;

@Injectable()
export class DiscoveryAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly ai?: AiContextSources,
    @Optional() private readonly tx?: TxRunner,
  ) {}

  onModuleInit(): void {
    this.ai?.register('search.part_demand', async () => {
      if (!this.tx) return null;
      const { rows } = await this.tx.run({ actorType: 'system' }, ({ db }) =>
        sql<{ node: string; n: string }>`SELECT part_category_node_id AS node, count(*) AS n FROM discovery.match_sessions
                                          WHERE part_category_node_id IS NOT NULL AND created_at > now() - interval '30 days'
                                          GROUP BY part_category_node_id ORDER BY n DESC LIMIT 50`.execute(db),
      );
      const max = Math.max(1, ...rows.map((r) => Number(r.n)));
      return { public_demand: rows.map((r) => ({ part_category_node_id: r.node, demand_score: Math.round((Number(r.n) / max) * 100) })) };
    });
    this.retention?.register('MatchSession', async (scope, p) => {
      const r = await sql`UPDATE discovery.match_sessions SET ${ANONYMIZE}
                           WHERE created_at < ${retentionCutoff(p)} AND (query_text IS NOT NULL OR latitude IS NOT NULL OR requester_user_id IS NOT NULL)`.execute(
        scope.db,
      );
      return Number(r.numAffectedRows ?? 0);
    });
    this.personal?.register('discovery', {
      async erase(scope, userId) {
        const r = await sql`UPDATE discovery.match_sessions SET ${ANONYMIZE} WHERE requester_user_id = ${userId}::uuid`.execute(scope.db);
        return Number(r.numAffectedRows ?? 0);
      },
    });
  }
}
