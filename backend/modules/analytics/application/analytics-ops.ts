// Analytics and audit operations: events.ingest (40 §22, api host) and the
// admin reads admin.audit_search and admin.analytics_dashboard (§23.5).
// Ingest validates every event against the registry (unknown names,
// properties or values are dropped and counted) and hands the accepted ones
// to W12 on a queue: the API never sees pseudonym keys (43 §21 grants).
// Audit search reads the append-only log within 93 days and is audited
// itself; dashboards read aggregates only (no personal data).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { StaffNames, staffOf } from '#modules/admin/interface/admin.js';
import { DASHBOARDS, dec4, validateClientEvent, type ClientEventInput, type DashboardKey } from '../domain/events.js';
import { ANALYTICS_INGEST_QUEUE, AnalyticsPools, type IngestBatch } from './pipeline.js';

const MAX_RANGE_MS = 93 * 86_400_000;

@Injectable()
@Operation('events.ingest')
export class EventsIngestHandler implements OperationHandler {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  async handle(ctx: OperationContext<{ platform: string; app_version: string; events: ClientEventInput[] }>): Promise<OperationResult> {
    const b = ctx.body;
    const accepted: IngestBatch['events'] = [];
    const now = Date.now();
    for (const e of b.events) {
      const properties = validateClientEvent(e, now);
      if (properties)
        accepted.push({
          event_name: e.event_name,
          schema_version: e.schema_version,
          occurred_at: e.occurred_at,
          ...(e.session_id ? { session_id: e.session_id } : {}),
          properties,
        });
    }
    if (accepted.length) {
      const batch: IngestBatch = {
        user_id: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        platform: b.platform,
        app_version: b.app_version,
        locale: ctx.locale,
        events: accepted,
      };
      await this.infra.jobs.enqueue(ANALYTICS_INGEST_QUEUE, { jobId: uuidv7(), data: batch as unknown as Record<string, unknown> });
    }
    return { status: 202, body: { accepted: accepted.length, rejected: b.events.length - accepted.length } };
  }
}

type AuditSearch = {
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  action?: string;
  from: string;
  to: string;
  limit?: number;
};

@Injectable()
@Operation('admin.audit_search')
export class AuditSearchHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<AuditSearch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const from = new Date(b.from);
    const to = new Date(b.to);
    if (to <= from) throw ApiError.validation([{ pointer: '/to', code: 'order' }]);
    if (to.getTime() - from.getTime() > MAX_RANGE_MS)
      throw ApiError.validation([{ pointer: '/to', code: 'out_of_range', limit: '93 days' }]);
    const limit = b.limit ?? 20;
    const pos = ctx.cursor as { at?: string; id?: string } | undefined;
    const body = await ctx.tx(async (scope) => {
      let q = scope.db.selectFrom('analytics.audit_logs').selectAll().where('created_at', '>=', from).where('created_at', '<', to);
      if (b.entity_type) q = q.where('entity_type', '=', b.entity_type);
      if (b.entity_id) q = q.where('entity_id', '=', b.entity_id);
      if (b.actor_id) q = q.where('actor_id', '=', b.actor_id);
      if (b.action) q = q.where('action', '=', b.action);
      if (pos?.at && pos.id) q = q.where(sql<boolean>`(created_at, id) < (${new Date(pos.at)}, ${pos.id}::uuid)`);
      const rows = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const names = await this.names.names(
        scope,
        page.filter((r) => r.actor_type !== 'system').map((r) => r.actor_id),
        ctx.locale,
      );
      // SEC-LOG / 40 admin.audit_search AUD: the search itself is audited.
      await writeAudit(scope, {
        action: 'audit.searched',
        entityType: b.entity_type ?? 'audit_log',
        entityId: b.entity_id ?? s.userId,
        next: JSON.stringify({ ...b, cursor: undefined, limit }).slice(0, 2000),
      });
      const last = page.at(-1);
      return ctx.page(
        page.map((r) => ({
          id: r.id,
          actor_type: r.actor_type,
          actor_display: r.actor_type === 'system' ? 'CarPal' : (names.get(r.actor_id) ?? 'CarPal'),
          organization_id: r.organization_id,
          action: r.action,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          previous_state_summary: r.previous_state_summary || null,
          new_state_summary: r.new_state_summary || null,
          reason: r.reason && [...r.reason].length >= 3 ? r.reason : null,
          request_id: r.request_id,
          created_at: iso(r.created_at),
        })),
        rows.length > limit && last ? { at: iso(last.created_at), id: last.id } : null,
      );
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.analytics_dashboard')
export class AnalyticsDashboardHandler implements OperationHandler {
  constructor(private readonly pools: AnalyticsPools) {}

  async handle(
    ctx: OperationContext<undefined, { from: string; to: string; region?: string; organization_type?: string }>,
  ): Promise<OperationResult> {
    staffOf(ctx);
    const key = ctx.params.dashboard_key as DashboardKey;
    const metrics = DASHBOARDS[key];
    if (!metrics) throw new ApiError('NOT_FOUND');
    const q = ctx.query;
    if (q.to < q.from) throw ApiError.validation([{ pointer: '/query/to', code: 'order' }]);
    if (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`) > 366 * 86_400_000)
      throw ApiError.validation([{ pointer: '/query/to', code: 'out_of_range', limit: '366 days' }]);
    // Aggregates are stored without dimensions in the MVP (dimension_key ''): region and organization type filter nothing yet.
    const rows = await this.pools.reader.db
      .selectFrom('events.daily_metrics')
      .select(['metric_date', 'metric_key', 'value'])
      .where('metric_key', 'in', metrics)
      .where('dimension_key', '=', '')
      .where('metric_date', '>=', q.from)
      .where('metric_date', '<=', q.to)
      .orderBy('metric_date')
      .execute();
    return {
      body: {
        key,
        from: q.from,
        to: q.to,
        metrics: metrics.map((m) => {
          const series = rows
            .filter((r) => r.metric_key === m)
            .map((r) => ({ date: String(r.metric_date).slice(0, 10), value: dec4(Number(r.value)) }));
          const gauge = m.startsWith('gauge.');
          // Counts add up over the period; a gauge reports its latest value.
          const total = gauge
            ? Number(rows.filter((r) => r.metric_key === m).at(-1)?.value ?? 0)
            : series.reduce((a, p) => a + Number(p.value), 0);
          return { metric_key: m, value: dec4(total), unit: 'count', series: series.slice(-400) };
        }),
      },
    };
  }
}
