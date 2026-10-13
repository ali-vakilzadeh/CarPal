// Pre-visit report (40 PreVisitReport, 52 PreVisitReport, MVP Module H).
// Generated in the requester's transaction when the request is created or
// edited (the requester's context can read the vehicle and its history), so
// the provider never reads the customer's vehicle records: it reads the
// stored report, and its history fields only while the requester's
// service_history_sharing consent for this appointment is granted (SEC-AZ-8,
// checked on every read, never cached). The AI summary is a stub (null) until
// the ai-mcp module provides triage insights (S9); sending the request is the
// user's approval of the previewed report (40 Appendix D, SEC-AI-3).
import { Injectable } from '@nestjs/common';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import { l10n, type L10n, type Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService, type MediaAttachmentView } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { arr, type AppointmentRow, type ReportRow } from '../api/projections.js';
import type { Side } from '../domain/rules.js';

type StoredRepair = { service_date: string; service_system_node_id: string; description: string };

const WARNINGS: Record<string, string> = {
  en: 'The customer described a possibly safety-critical symptom. Check before driving the vehicle.',
  fa: 'مشتری علامتی را توصیف کرده که ممکن است به ایمنی مربوط باشد. پیش از رانندگی با خودرو بررسی کنید.',
};

const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

@Injectable()
export class PreVisitReports {
  constructor(
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly consents: ConsentChecker,
    private readonly media: MediaService,
  ) {}

  /** (Re)generates the stored report of an appointment in the requester's transaction. */
  async generate(scope: TxScope, a: AppointmentRow, locale: Locale): Promise<void> {
    const card = (await this.vehicles.cards(scope, [a.vehicle_id])).get(a.vehicle_id);
    const issue = a.related_issue_id ? await this.vehicles.issue(scope, a.related_issue_id) : null;
    const symptoms = [...new Set([a.symptom_node_id, issue?.symptomNodeId].filter((x): x is string => !!x))];
    const likely = new Set([a.service_system_node_id, a.service_task_node_id].filter((x): x is string => !!x));
    for (const s of symptoms) for (const m of await this.taxonomy.mappingsFrom(s)) if (likely.size < 20) likely.add(m.targetId);
    const labels = await this.taxonomy.labels(
      [card?.brandNodeId, card?.modelNodeId, card?.seriesNodeId, card?.engineTypeNodeId, ...likely].filter((x): x is string => !!x),
      locale,
    );
    const t = (id: string | null | undefined) => (id ? labels.get(id)?.text : undefined);
    const vehicleSummary = card
      ? [t(card.brandNodeId), t(card.modelNodeId), t(card.seriesNodeId), String(card.year), t(card.engineTypeNodeId)]
          .filter(Boolean)
          .join(' ')
      : '—';
    // History only with the appointment's service_history_sharing consent (52 PreVisitReport rule).
    let history: Awaited<ReturnType<VehicleCards['serviceHistory']>> = [];
    if (a.consent_to_share_history && a.consent_reference_id) history = await this.vehicles.serviceHistory(scope, a.vehicle_id, 50);
    const related = history.filter((h) => !a.service_system_node_id || h.serviceSystemNodeId === a.service_system_node_id).slice(0, 20);
    const repairs: StoredRepair[] = related.map((h) => ({
      service_date: h.serviceDate,
      service_system_node_id: h.serviceSystemNodeId,
      description: clip(h.description ?? '', 500),
    }));
    const lastMileage = history.find((h) => h.mileageKm !== null)?.mileageKm ?? null;
    const historySummary =
      a.consent_to_share_history && a.consent_reference_id
        ? history.length === 0
          ? locale === 'fa'
            ? 'سابقه سرویسی ثبت نشده است.'
            : 'No service history recorded.'
          : locale === 'fa'
            ? `${history.length} سابقه سرویس؛ آخرین مورد ${history[0]!.serviceDate}.`
            : `${history.length} service record(s); the latest on ${history[0]!.serviceDate}.`
        : null;
    const mediaIds = (await this.media.attachmentViews(scope, 'appointment', [a.id])).get(a.id)?.map((m) => m.attachment_id) ?? [];
    const values = {
      vehicle_summary: clip(vehicleSummary, 2000),
      mileage_km: lastMileage,
      reported_symptom_node_ids: symptoms.slice(0, 20),
      triage_status: a.triage_status,
      issue_summary: clip(issue ? `${issue.title}: ${a.description}` : a.description, 2000),
      ai_summary: null,
      likely_service_node_ids: [...likely].slice(0, 20),
      relevant_history_summary: historySummary,
      previous_related_repairs: historySummary === null ? null : JSON.stringify(repairs),
      known_warnings: a.safety_flag ? [WARNINGS[locale] ?? WARNINGS.en!] : [],
      suggested_focus_areas: [...likely]
        .map((id) => t(id))
        .filter((x): x is string => !!x)
        .slice(0, 20),
      media_attachment_ids: mediaIds.slice(0, 20),
      customer_expectations: a.customer_expectations,
      urgency_level: a.urgency_level,
      preferred_contact_channel: a.preferred_contact_channel,
      consent_reference_id: a.consent_to_share_history ? a.consent_reference_id : null,
      generated_at: new Date(),
      status: a.status === 'draft' ? 'draft' : 'shared',
    };
    await scope.db
      .insertInto('appointment.pre_visit_reports')
      .values({ appointment_id: a.id, ...values })
      .onConflict((oc) => oc.column('appointment_id').doUpdateSet(values))
      .execute();
  }

  /** 40 PreVisitReport for a side; history fields only under an active consent for the provider. */
  async view(scope: TxScope, a: AppointmentRow, side: Side, locale: Locale) {
    const r = (await scope.db
      .selectFrom('appointment.pre_visit_reports')
      .selectAll()
      .where('appointment_id', '=', a.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()) as ReportRow | undefined;
    if (!r) return null;
    let historyAllowed = r.consent_reference_id !== null;
    if (historyAllowed && side === 'provider')
      historyAllowed = await this.consents.isGranted(scope, {
        consentType: 'service_history_sharing',
        subject: { type: 'user', id: a.requester_user_id },
        scopeEntity: { type: 'appointment', id: a.id },
        grantee: { type: 'organization', id: a.provider_organization_id },
      });
    const repairs = historyAllowed ? ((r.previous_related_repairs as StoredRepair[] | null) ?? []) : null;
    const symptomIds = arr(r.reported_symptom_node_ids);
    const likelyIds = arr(r.likely_service_node_ids);
    const labels = await this.taxonomy.labels(
      [...symptomIds, ...likelyIds, ...(repairs ?? []).map((x) => x.service_system_node_id)],
      locale,
    );
    const nodes = (ids: string[]) =>
      ids
        .filter((id) => labels.has(id))
        .slice(0, 20)
        .map((id) => ({ node_id: id, label: labels.get(id)! }));
    const views =
      side === 'provider'
        ? await this.media.sharedAttachmentViews(scope, 'appointment', [a.id])
        : await this.media.attachmentViews(scope, 'appointment', [a.id]);
    const keep = new Set(arr(r.media_attachment_ids));
    const media: MediaAttachmentView[] = (views.get(a.id) ?? []).filter((m) => keep.has(m.attachment_id)).slice(0, 20);
    const fallback: L10n = l10n({ en: '—' }, locale)!;
    return {
      ...meta(r),
      appointment_id: a.id,
      vehicle_summary: r.vehicle_summary,
      mileage_km: r.mileage_km === null ? null : Number(r.mileage_km),
      reported_symptoms: nodes(symptomIds),
      triage_status: r.triage_status,
      issue_summary: r.issue_summary,
      ai_summary: r.ai_summary,
      ai_summary_status: r.ai_summary === null ? 'not_required' : a.status === 'draft' ? 'pending' : 'approved',
      likely_services: nodes(likelyIds),
      relevant_history_summary: historyAllowed ? r.relevant_history_summary : null,
      previous_related_repairs: repairs
        ? repairs.slice(0, 20).map((x) => ({
            service_date: x.service_date,
            service_system: labels.get(x.service_system_node_id) ?? fallback,
            description: x.description,
          }))
        : null,
      known_warnings: arr(r.known_warnings).slice(0, 20),
      suggested_focus_areas: arr(r.suggested_focus_areas).slice(0, 20),
      media,
      customer_expectations: r.customer_expectations,
      urgency_level: r.urgency_level,
      fleet_approval_status: r.fleet_approval_status,
      preferred_contact_channel: r.preferred_contact_channel,
      generated_at: isoOrNull(r.generated_at),
      status: r.status,
    };
  }
}

export const isoDate = (d: Date | string) => iso(d).slice(0, 10);
