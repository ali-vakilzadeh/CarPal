// The vehicle module's parts of the AI facade (S9; 40 §21.3 vehicle helper
// and service history, §21.4 suggestions): context packages of a vehicle the
// caller owns (personal, or the fleet's in the fleet context; ids, year,
// mileage and counts, never the VIN or the plate) and the appliers of
// accepted suggestions, which follow vehicles.update and reminders.create.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AiContextSources, SuggestionAppliers, type AiPrincipal } from '#modules/ai-mcp/interface/ai.js';
import { FleetPartners } from '#modules/fleet/interface/fleet.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { reminderStatus, todayUtc } from '../domain/rules.js';
import { applyVehicleSuggestion } from './vehicle-ops.js';

const ownerOf = (who: { orgId: string | null; userId: string }) =>
  who.orgId ? { type: 'organization' as const, id: who.orgId } : { type: 'user' as const, id: who.userId };

async function ownedVehicle(scope: TxScope, owner: { type: 'user' | 'organization'; id: string }, id: unknown) {
  if (typeof id !== 'string') return undefined;
  return scope.db
    .selectFrom('vehicle.vehicles')
    .select([
      'id',
      'brand_node_id',
      'model_node_id',
      'series_node_id',
      'engine_type_node_id',
      'fuel_type_node_id',
      'year',
      'mileage_km',
      'status',
    ])
    .where('id', '=', id)
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('deleted_at', 'is', null)
    .where('status', '<>', 'archived')
    .executeTakeFirst();
}

@Injectable()
export class VehicleAiRegistrations implements OnModuleInit {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    @Optional() private readonly sources?: AiContextSources,
    @Optional() private readonly appliers?: SuggestionAppliers,
    @Optional() private readonly partners?: FleetPartners,
  ) {}

  onModuleInit(): void {
    this.sources?.register('vehicle.profile', async (scope, who, args) => {
      const v = await ownedVehicle(scope, ownerOf(who), args.vehicle_id);
      if (!v) return null;
      const { nodes } = await this.taxonomy.catalog();
      const series = nodes
        .filter((n) => n.type === 'vehicle_series' && n.parentId === v.model_node_id && n.status === 'active')
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((n) => n.id);
      const reminders = await scope.db
        .selectFrom('vehicle.maintenance_reminders')
        .select('reminder_type')
        .distinct()
        .where('vehicle_id', '=', v.id)
        .where('status', 'in', ['upcoming', 'due', 'overdue'])
        .where('deleted_at', 'is', null)
        .execute();
      const issues = await scope.db
        .selectFrom('vehicle.vehicle_issues')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('vehicle_id', '=', v.id)
        .where('status', 'in', ['open', 'investigating', 'scheduled'])
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return {
        vehicle: { ...v, mileage_km: v.mileage_km === null ? null : Number(v.mileage_km) },
        candidates: { series_node_id: series.slice(0, 20) },
        open_reminder_types: reminders.map((r) => r.reminder_type),
        open_issue_count: Number(issues.n),
        today: todayUtc(),
      };
    });

    this.sources?.register('vehicle.history', async (scope, who, args) => {
      const v = await ownedVehicle(scope, ownerOf(who), args.vehicle_id);
      if (!v) return null;
      const history = await scope.db
        .selectFrom('vehicle.vehicle_service_records')
        .select(['id', 'service_date', 'service_system_node_id'])
        .where('vehicle_id', '=', v.id)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .orderBy('service_date', 'desc')
        .limit(200)
        .execute();
      return { vehicle: { id: v.id, year: v.year }, history };
    });

    // ai.fleet_suggestions: the fleet's own vehicles with open issue and overdue reminder counts (no plates, no VINs).
    this.sources?.register('fleet.vehicles', async (scope, who, args) => {
      if (!who.orgId) return null;
      const wanted = Array.isArray(args.vehicle_ids) ? [...new Set(args.vehicle_ids as string[])].slice(0, 100) : [];
      let q = scope.db
        .selectFrom('vehicle.vehicles as v')
        .select([
          'v.id',
          'v.status',
          'v.year',
          (eb) =>
            eb
              .selectFrom('vehicle.vehicle_issues as i')
              .select((x) => x.fn.countAll<string>().as('n'))
              .whereRef('i.vehicle_id', '=', 'v.id')
              .where('i.status', 'in', ['open', 'investigating'])
              .where('i.deleted_at', 'is', null)
              .as('open_issues'),
          (eb) =>
            eb
              .selectFrom('vehicle.vehicle_issues as i')
              .select((x) => x.fn.countAll<string>().as('n'))
              .whereRef('i.vehicle_id', '=', 'v.id')
              .where('i.status', 'in', ['open', 'investigating'])
              .where('i.urgency_level', '=', 'safety_critical')
              .where('i.deleted_at', 'is', null)
              .as('safety_issues'),
          (eb) =>
            eb
              .selectFrom('vehicle.maintenance_reminders as r')
              .select((x) => x.fn.countAll<string>().as('n'))
              .whereRef('r.vehicle_id', '=', 'v.id')
              .where('r.status', '=', 'overdue')
              .where('r.deleted_at', 'is', null)
              .as('overdue_reminders'),
        ])
        .where('v.owner_type', '=', 'organization')
        .where('v.owner_id', '=', who.orgId)
        .where('v.status', '<>', 'archived')
        .where('v.deleted_at', 'is', null);
      if (wanted.length) q = q.where('v.id', 'in', wanted);
      const rows = await q.orderBy('v.id').limit(1000).execute();
      if (wanted.length && rows.length !== wanted.length) return null;
      const preferred = (await this.partners?.preferredProviders(scope, who.orgId)) ?? [];
      return {
        vehicles: rows.map((r) => ({
          id: r.id,
          status: r.status,
          year: r.year,
          open_issues: Number(r.open_issues ?? 0),
          safety_issues: Number(r.safety_issues ?? 0),
          overdue_reminders: Number(r.overdue_reminders ?? 0),
        })),
        preferred_provider_ids: preferred.map((p) => p.organizationId).slice(0, 10),
      };
    });

    this.appliers?.register('vehicle', async (scope, s) => {
      const owner = s.organizationId
        ? { type: 'organization' as const, id: s.organizationId }
        : { type: 'user' as const, id: s.ownerUserId! };
      await applyVehicleSuggestion(scope, this.taxonomy, owner, s.targetId, s.payload as Record<string, string>, '/edited_payload');
    });

    this.appliers?.register('maintenance_reminder', async (scope, s) => {
      const who: Pick<AiPrincipal, 'orgId' | 'userId'> = { orgId: s.organizationId, userId: s.ownerUserId ?? s.actorUserId };
      const v = await ownedVehicle(scope, ownerOf(who), s.targetId);
      if (!v) throw new ApiError('NOT_FOUND');
      const p = s.payload as { reminder_type: string; title: string; due_by_date: string; reason: string | null };
      const today = todayUtc();
      if (p.due_by_date < today) throw ApiError.validation([{ pointer: '/edited_payload/due_by_date', code: 'in_past' }]);
      await scope.db
        .insertInto('vehicle.maintenance_reminders')
        .values({
          vehicle_id: v.id,
          reminder_type: p.reminder_type,
          title: p.title,
          reason: p.reason,
          source: 'ai_suggestion',
          insight_id: s.insightId,
          due_by_date: p.due_by_date,
          priority: 'medium',
          status: reminderStatus(
            { status: 'upcoming', due_by_date: p.due_by_date, due_by_mileage_km: null, snoozed_until: null },
            v.mileage_km === null ? null : Number(v.mileage_km),
            today,
          ),
        })
        .execute();
    });
  }
}
