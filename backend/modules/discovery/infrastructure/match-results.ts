// MatchResults (interface/match-results.ts) in the caller's RLS context.
import { Injectable } from '@nestjs/common';
import type { TxScope } from '#libs/tenancy/index.js';
import { MatchResults } from '../interface/match-results.js';

@Injectable()
export class DbMatchResults extends MatchResults {
  async linkAppointment(scope: TxScope, matchResultId: string, providerOrgId: string, appointmentId: string): Promise<boolean> {
    const r = await scope.db
      .updateTable('discovery.match_results')
      .set({ appointment_id: appointmentId })
      .where('id', '=', matchResultId)
      .where('target_entity_type', '=', 'organization')
      .where('target_entity_id', '=', providerOrgId)
      .where('appointment_id', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
}
