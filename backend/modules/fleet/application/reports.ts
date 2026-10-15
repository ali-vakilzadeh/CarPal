// Fleet analytics (40 fleet.report, FleetReport; MVP Module K; 54 §8):
// computed per request from the fleet's service records, issues and
// appointments, read through the vehicle and appointment interfaces in the
// fleet's own context. Costs count only records in the reporting currency.
// The same rows feed the CSV exports (W8).
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { vehicleLabels } from './fleet-ops.js';

export type ReportType =
  'costs' | 'repair_frequency' | 'downtime' | 'provider_usage' | 'preferred_provider_performance' | 'common_issues' | 'service_frequency';
export type GroupBy = 'vehicle' | 'month' | 'service_system' | 'provider' | 'symptom';

/** Allowed groupings per report; the first is the default. */
export const GROUPINGS: Record<ReportType, GroupBy[]> = {
  costs: ['vehicle', 'month', 'service_system', 'provider'],
  repair_frequency: ['vehicle', 'month', 'service_system'],
  service_frequency: ['service_system', 'month', 'vehicle'],
  downtime: ['vehicle', 'provider', 'month'],
  provider_usage: ['provider', 'month'],
  preferred_provider_performance: ['provider'],
  common_issues: ['symptom', 'month', 'vehicle'],
};

export interface ReportRow {
  key: string;
  label: string;
  value: string;
  count: number;
}

const MAX_DAYS = 366;
const dec2 = (v: number) => String(Math.round(Math.max(0, v) * 100) / 100);

/** from ≤ to, at most 366 days (40 fleet.report). */
export function reportRange(from: string, to: string): { from: Date; to: Date } {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
  if (t <= f) throw ApiError.validation([{ pointer: '/query/to', code: 'order' }]);
  if (t.getTime() - f.getTime() > MAX_DAYS * 86_400_000)
    throw ApiError.validation([{ pointer: '/query/to', code: 'out_of_range', limit: '366 days' }]);
  return { from: f, to: t };
}

interface Bucket {
  value: number;
  count: number;
}

@Injectable()
export class FleetReports {
  constructor(
    private readonly vehicles: VehicleCards,
    private readonly appointments: AppointmentFacts,
    private readonly taxonomy: TaxonomyResolver,
    private readonly orgs: OrgCards,
  ) {}

  async build(
    scope: TxScope,
    orgId: string,
    type: ReportType,
    range: { from: string; to: string },
    groupBy: GroupBy,
    currency: string | null,
    locale: Locale,
    preferredProviders: readonly string[] = [],
  ): Promise<ReportRow[]> {
    const { from, to } = reportRange(range.from, range.to);
    const buckets = new Map<string, Bucket>();
    const add = (key: string, value: number, count = 1) => {
      const b = buckets.get(key) ?? { value: 0, count: 0 };
      b.value += value;
      b.count += count;
      buckets.set(key, b);
    };
    const month = (d: string | Date) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 7);
    let averaged = false;
    if (type === 'costs' || type === 'repair_frequency' || type === 'service_frequency') {
      const records = await this.vehicles.fleetServiceRecords(scope, orgId, range.from, range.to);
      for (const r of records) {
        const key =
          groupBy === 'vehicle'
            ? r.vehicleId
            : groupBy === 'month'
              ? month(r.serviceDate)
              : groupBy === 'provider'
                ? (r.providerOrgId ?? 'unknown')
                : r.serviceSystemNodeId;
        if (type === 'costs') {
          if (r.costAmount === null || (currency && r.currency !== currency)) continue;
          add(key, Number(r.costAmount));
        } else add(key, 1);
      }
    } else if (type === 'common_issues') {
      for (const i of await this.vehicles.fleetIssues(scope, orgId, from, to)) {
        const key = groupBy === 'vehicle' ? i.vehicleId : groupBy === 'month' ? month(i.createdAt) : (i.symptomNodeId ?? 'unspecified');
        add(key, 1);
      }
    } else {
      const appts = await this.appointments.fleetAppointments(scope, orgId, from, to);
      for (const a of appts) {
        const key = groupBy === 'vehicle' ? a.vehicleId : groupBy === 'month' ? month(a.createdAt) : a.providerOrgId;
        if (type === 'provider_usage') add(key, 1);
        else if (type === 'downtime' || type === 'preferred_provider_performance') {
          if (type === 'preferred_provider_performance' && !preferredProviders.includes(a.providerOrgId)) continue;
          // 54 §8 fleet_downtime_avg: checked_in → ready_for_pickup (or completed), in hours.
          if (!a.checkedInAt || !a.finishedAt) continue;
          add(key, Math.max(0, (a.finishedAt.getTime() - a.checkedInAt.getTime()) / 3_600_000));
          averaged = true;
        }
      }
    }
    const keys = [...buckets.keys()];
    const labels = await this.labels(scope, orgId, groupBy, keys, locale);
    return [...buckets.entries()]
      .map(([key, b]) => ({
        key: key.slice(0, 120),
        label: (labels.get(key) ?? key).slice(0, 160),
        value: dec2(
          averaged || type === 'downtime' || type === 'preferred_provider_performance' ? (b.count ? b.value / b.count : 0) : b.value,
        ),
        count: Math.min(b.count, 10_000_000),
      }))
      .sort((a, b) => Number(b.value) - Number(a.value) || b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, 1000);
  }

  private async labels(scope: TxScope, orgId: string, groupBy: GroupBy, keys: string[], locale: Locale): Promise<Map<string, string>> {
    const real = keys.filter((k) => /^[0-9a-f-]{36}$/.test(k));
    if (groupBy === 'vehicle') return vehicleLabels(this.vehicles, this.taxonomy, scope, orgId, real, locale);
    if (groupBy === 'provider') {
      const cards = await this.orgs.cards(scope, real);
      return new Map([...cards].map(([id, c]) => [id, c.name]));
    }
    if (groupBy === 'service_system' || groupBy === 'symptom') {
      const l = await this.taxonomy.labels(real, locale);
      return new Map([...l].map(([id, v]) => [id, v.text]));
    }
    return new Map();
  }
}
