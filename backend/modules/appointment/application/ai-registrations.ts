// The appointment module's part of the AI facade (S9; 40
// ai.appointment_suggestions): one appointment of the caller's provider
// organization (provider context; never a draft), with the overlapping
// confirmed appointments counted and the customer's own description clipped
// as data for the tool (SEC-AI-2).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { AiContextSources } from '#modules/ai-mcp/interface/ai.js';

/** Typical durations by appointment type when the request names none (minutes). */
const TYPICAL: Record<string, number> = { diagnosis: 60, repair: 120, inspection: 45, bodywork_estimate: 30, parts_installation: 90 };

@Injectable()
export class AppointmentAiRegistrations implements OnModuleInit {
  constructor(@Optional() private readonly sources?: AiContextSources) {}

  onModuleInit(): void {
    this.sources?.register('provider.appointment', async (scope, who, args) => {
      if (!who.orgId || typeof args.appointment_id !== 'string') return null;
      const a = await scope.db
        .selectFrom('appointment.appointments')
        .select([
          'id',
          'appointment_type',
          'estimated_duration_minutes',
          'description',
          'service_task_node_id',
          'proposed_start_at',
          'proposed_end_at',
          'confirmed_start_at',
          'confirmed_end_at',
        ])
        .where('id', '=', args.appointment_id)
        .where('provider_organization_id', '=', who.orgId)
        .where('status', '<>', 'draft')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!a) return null;
      const start = a.confirmed_start_at ?? a.proposed_start_at;
      const end = a.confirmed_end_at ?? a.proposed_end_at;
      let conflicts = 0;
      if (start && end) {
        const r = await scope.db
          .selectFrom('appointment.appointments')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('provider_organization_id', '=', who.orgId)
          .where('id', '<>', a.id)
          .where('status', 'in', ['confirmed', 'checked_in', 'in_progress'])
          .where('confirmed_start_at', '<', end)
          .where('confirmed_end_at', '>', start)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        conflicts = Number(r.n);
      }
      return {
        appointment_type: a.appointment_type,
        estimated_duration_minutes: a.estimated_duration_minutes,
        typical_duration_minutes: a.estimated_duration_minutes ?? TYPICAL[a.appointment_type] ?? 60,
        conflict_count: conflicts,
        description_excerpt: [...a.description].slice(0, 300).join(''),
      };
    });
  }
}
