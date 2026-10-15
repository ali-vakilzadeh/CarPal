// Discovery's parts of S8 platform flows: retention of match sessions (52
// DataRetentionPolicy MatchSession 180 d, anonymize: the query text and
// position leave, the ranking stays for metrics) and data subject requests (a
// user's search sessions are anonymized the same way on deletion).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { retentionCutoff, RetentionHandlers } from '#modules/admin/interface/admin.js';
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
  ) {}

  onModuleInit(): void {
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
