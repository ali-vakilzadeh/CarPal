'use client';
// PW-JOB-01 Close job (provider plan PW4.T3; Docs/11 Ch.7; RF-12) at /<locale>/provider/jobs/<id>/close: the outcome
// of a finished job on one phone page — service system and task prefilled from the request (the pre-visit report's
// likely services, else the request's labels; the Appointment has labels, not node ids), labour cost and parts cost
// (cost_breakdown, their sum as final_cost, in the base currency), optional part lines (name, part number, quantity:
// business-ui PartLines), warranty note, invoice photo and internal note. Field errors from the server show beside
// their field. Completion creates the service record on the customer's car and the review invitation
// (provider.appointments_transition → completed; appointment.completed).
// The contract's completion has no invoice or internal note: the internal note goes to provider.note_create
// (internal) and the invoice photo to a job log of the visit (provider.job_log_create with appointment_id and
// service_record_id, then media.attach role evidence; purpose job_log_photo, owned by the business) — the provider
// cannot attach to the appointment (its requester owns it) nor to the customer's service record (PRV-BR-16).
import type { Appointment, AppointmentStatus } from '@carpal/api-contracts';
import { PartLines, type PartLine } from '@carpal/business-ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { SelectField } from '@/components/fields/select-field';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { UploadZone, discardGroup, releaseGroup, uploadsOf, useUploads, whenReady } from '@/features/media';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useRegion } from '@/lib/config/client';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useActiveBusiness } from './context';
import {
  closeFieldOf,
  closeJob,
  jobLogDate,
  parseMoney,
  prefillNode,
  sumMoney,
  type CloseDraft,
  type CloseErrors,
  type CloseField,
} from './job-model';
import { workshopPath } from './model';
import { MAX_NOTE, vehicleLine } from './requests-model';

const ERROR_KEYS: Record<CloseField, MessageKey> = {
  system: 'provider.jobs.close.errors.system',
  task: 'provider.jobs.close.errors.task',
  labour: 'provider.jobs.close.errors.amount',
  parts: 'provider.jobs.close.errors.amount',
  lines: 'provider.jobs.close.errors.lines',
  warranty: 'provider.jobs.close.errors.warranty',
  total: 'provider.jobs.close.errors.total',
};

export function WorkshopCloseJob({ appointmentId }: { appointmentId: string }) {
  const t = useT();
  const locale = useLocale();
  const { orgId } = useActiveBusiness();
  const path = { org_id: orgId, appointment_id: appointmentId };
  const q = useApiQuery('provider.appointments_get', { path }, { staleTime: 10_000 });
  // 404 = no report: the prefill then uses the request's labels only.
  const report = useApiQuery('pre_visit.provider_get', { path }, { enabled: !!q.data, retry: false, staleTime: 60_000 });
  const jobHref = workshopPath(locale, `jobs/${encodeURIComponent(appointmentId)}`);
  const back = (
    <Link href={jobHref} className="pwa-link pwa-ws-back">
      <Icon name="back" size={20} /> {t('provider.jobs.close.back')}
    </Link>
  );
  const a = q.data;
  if (!a || (report.isPending && report.fetchStatus !== 'idle')) {
    if (!a && !q.isPending)
      return (
        <div className="pwa-ws-page">
          {back}
          <StateView kind={stateFromProblem(q.error)} t={t} />
        </div>
      );
    return <SkeletonCard lines={8} />;
  }
  if (!a.allowed_transitions.includes('completed'))
    return (
      <div className="pwa-ws-page">
        {back}
        <Banner
          tone="warn"
          icon="info"
          text={t('provider.jobs.close.notNow', { status: t(`provider.status.${a.status}` as MessageKey) })}
        />
      </div>
    );
  const likely = (report.data?.likely_services ?? []).map((s) => s.node_id);
  return <CloseForm a={a} orgId={orgId} likely={likely} back={back} jobHref={jobHref} />;
}

function CloseForm({
  a,
  orgId,
  likely,
  back,
  jobHref,
}: {
  a: Appointment;
  orgId: string;
  likely: readonly string[];
  back: ReactNode;
  jobHref: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const api = useApiClient();
  const toast = useToast();
  const region = useRegion();
  const queryClient = useQueryClient();
  const path = { org_id: orgId, appointment_id: a.id };
  const group = `job-invoice:${a.id}`;
  const uploads = useUploads(group);

  const [d, setD] = useState<Omit<CloseDraft, 'systemId' | 'taskId'>>({ labour: '', parts: '', lines: [], warranty: '' });
  const [lines, setLines] = useState<PartLine[]>([]);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<CloseErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));

  // System and task: the user's choice, else the prefill from the request once the lists are in (null = not chosen).
  const [systemChoice, setSystemChoice] = useState<string | null>(null);
  const [taskChoice, setTaskChoice] = useState<string | null>(null);
  const systems = useTaxonomyNodes('service_system');
  const systemId = systemChoice ?? (systems.data ? prefillNode(systems.data, a.service_system?.text, likely) : '');
  const tasks = useTaxonomyNodes('service_task', systemId || null, !!systemId);
  const taskId = taskChoice ?? (tasks.data ? prefillNode(tasks.data, a.service_task?.text, likely) : '');

  const labour = parseMoney(d.labour);
  const parts = parseMoney(d.parts);
  const total = labour || parts ? sumMoney([labour, parts].filter((x): x is string => !!x)) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const lineRows = lines.map((l) => ({ name: l.name, partNumber: l.partNumber, quantity: l.quantity }));
    const r = closeJob({ ...d, systemId, taskId, lines: lineRows }, region.currency);
    if ('errors' in r) return setErrors(r.errors);
    setErrors({});
    setBusy(true);
    let next: Appointment;
    try {
      next = await api.api('provider.appointments_transition', { path, body: r.body });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') {
        const fresh = await api.api('provider.appointments_get', { path }).catch(() => null);
        if (fresh) queryClient.setQueryData(apiQueryKey('provider.appointments_get', { path }), fresh);
        return setFormError(
          t('provider.jobs.errors.changed', {
            status: t(`provider.status.${(fresh?.status ?? a.status) as AppointmentStatus}` as MessageKey),
          }),
        );
      }
      if (err instanceof ApiProblem && err.fields.length) {
        const fields: CloseErrors = {};
        for (const x of err.fields) {
          const k = closeFieldOf(x.pointer);
          if (k) fields[k] = true;
        }
        if (Object.keys(fields).length) return setErrors(fields);
      }
      return setFormError(
        t(
          err instanceof ApiProblem && err.status === 403
            ? 'provider.jobs.errors.forbidden'
            : err instanceof ApiProblem && err.code === 'NETWORK'
              ? 'provider.jobs.errors.offline'
              : 'provider.jobs.errors.failed',
        ),
      );
    }
    queryClient.setQueryData(apiQueryKey('provider.appointments_get', { path }), next);
    void queryClient.invalidateQueries({ queryKey: ['provider.appointments_list'] });
    // After the job is closed: the internal note, then the invoice photo (best effort; the job stays closed).
    const text = note.trim();
    if (text)
      await api
        .api('provider.note_create', { path, body: { note_type: 'internal', body: text.slice(0, MAX_NOTE), content_locale: locale } })
        .catch(() => toast(t('provider.jobs.close.noteFailed')));
    if (uploadsOf(group).some((u) => u.state.phase !== 'failed'))
      await attachInvoice(api, orgId, next, r.body.service_record!, group, () => toast(t('provider.jobs.close.invoiceFailed')));
    else releaseGroup(group);
    setBusy(false);
    router.replace(jobHref);
  };

  const err = (k: CloseField) => (errors[k] ? t(ERROR_KEYS[k]) : undefined);
  return (
    <form className="pwa-ws-page pwa-stack" onSubmit={(e) => void submit(e)} noValidate aria-labelledby="close-title">
      {back}
      <header className="pwa-stack-xs">
        <h1 id="close-title" className="pwa-ws-title">
          {t('provider.jobs.close.title')}
        </h1>
        <p className="pwa-text-body m-0">
          <bdi>{a.requester_display}</bdi> · <bdi>{vehicleLine(a.vehicle, f.digits)}</bdi>
        </p>
      </header>

      <div className="pwa-form-grid">
        <SelectField
          label={t('provider.jobs.close.system')}
          value={systemId}
          onChange={(id) => {
            setSystemChoice(id);
            setTaskChoice(null);
          }}
          placeholder={t('provider.jobs.close.chooseSystem')}
          options={(systems.data ?? []).map((n) => ({ value: n.id, label: n.name.text }))}
          error={err('system')}
          required
        />
        <SelectField
          label={t('provider.jobs.close.task')}
          value={taskId}
          onChange={(id) => {
            setTaskChoice(id);
          }}
          placeholder={systemId ? t('provider.jobs.close.anyTask') : t('provider.jobs.close.systemFirst')}
          options={(tasks.data ?? []).map((n) => ({ value: n.id, label: n.name.text }))}
          disabled={!systemId}
          error={err('task')}
        />
      </div>

      <fieldset className="pwa-ws-fieldset">
        <legend className="pwa-text-label">{t('provider.jobs.close.cost')}</legend>
        <div className="pwa-form-grid">
          <TextField
            label={t('provider.jobs.close.labour')}
            value={d.labour}
            inputMode="decimal"
            onChange={(e) => set('labour', e.target.value)}
            end={<span className="pwa-text-caption">{region.currency}</span>}
            error={err('labour')}
          />
          <TextField
            label={t('provider.jobs.close.parts')}
            value={d.parts}
            inputMode="decimal"
            onChange={(e) => set('parts', e.target.value)}
            end={<span className="pwa-text-caption">{region.currency}</span>}
            error={err('parts')}
          />
        </div>
        {errors.total ? (
          <p className="pwa-error-text m-0" role="alert">
            {t(ERROR_KEYS.total)}
          </p>
        ) : total ? (
          <p className="pwa-text-caption m-0" data-testid="close-total">
            {t('provider.jobs.close.total', { amount: f.money(total, region.currency) })}
          </p>
        ) : null}
      </fieldset>

      <PartLines
        rows={lines}
        onChange={setLines}
        error={err('lines')}
        words={{
          legend: t('provider.jobs.close.lines'),
          name: t('provider.jobs.close.partName'),
          partNumber: t('provider.jobs.close.partNumber'),
          quantity: t('provider.jobs.close.quantity'),
          add: t('provider.jobs.close.addPart'),
          remove: (n) => t('provider.jobs.close.removePart', { n: f.number(n) }),
        }}
      />
      {lines.length === 0 ? null : <p className="pwa-text-caption m-0">{t('provider.jobs.close.linesHint')}</p>}

      <TextField
        label={t('provider.jobs.close.warranty')}
        hint={t('provider.jobs.close.warrantyHint')}
        value={d.warranty}
        maxLength={500}
        onChange={(e) => set('warranty', e.target.value)}
        error={err('warranty')}
      />

      <UploadZone
        group={group}
        purpose="job_log_photo"
        organizationId={orgId}
        label={t('provider.jobs.close.invoice')}
        hint={t('provider.jobs.close.invoiceHint')}
      />

      <TextField
        multiline
        rows={3}
        label={t('provider.jobs.close.note')}
        hint={t('provider.jobs.close.noteHint')}
        value={note}
        maxLength={MAX_NOTE}
        onChange={(e) => setNote(e.target.value)}
      />

      <p className="pwa-text-caption m-0">{t('provider.jobs.close.after')}</p>
      {formError ? <Banner tone="danger" text={formError} /> : null}
      <div className="pwa-sticky-actions">
        <Button type="submit" variant="primary" loading={busy} data-testid="close-submit">
          {t('provider.jobs.close.submit')}
        </Button>
        <Link
          href={jobHref}
          className={buttonClass({ variant: 'ghost' })}
          onClick={() => {
            if (uploads.length) discardGroup(group);
          }}
        >
          <span className="cp-btn-label">{t('common.actions.cancel')}</span>
        </Link>
      </div>
    </form>
  );
}

/**
 * The invoice photo of a closed job: a job log of the visit (appointment_verified from the completed appointment; the
 * trust scorer does not count it again, 54 §1.1), then each photo attached to it as evidence once it is clean. Runs on
 * after the page is left (module scope), like the garage's invoice uploads.
 */
async function attachInvoice(
  api: ApiClient,
  orgId: string,
  a: Appointment,
  record: { service_system_node_id: string; service_task_node_id?: string },
  group: string,
  onFailed: () => void,
) {
  let jobLogId: string;
  try {
    const log = await api.api('provider.job_log_create', {
      path: { org_id: orgId },
      body: {
        job_date: jobLogDate(a.completed_at, Date.now()),
        service_system_node_id: record.service_system_node_id,
        ...(record.service_task_node_id ? { service_task_node_id: record.service_task_node_id } : {}),
        appointment_id: a.id,
        ...(a.service_record_id ? { service_record_id: a.service_record_id } : {}),
      },
    });
    jobLogId = log.id;
  } catch {
    discardGroup(group);
    onFailed();
    return;
  }
  uploadsOf(group).forEach((u, i) => {
    if (u.state.phase === 'failed') return;
    void whenReady(u.id).then(async (asset) => {
      if (!asset) return;
      await api
        .api('media.attach', {
          body: { media_asset_id: asset.id, attached_to: { type: 'provider_job_log', id: jobLogId }, role: 'evidence', display_order: i },
        })
        .catch(onFailed);
    });
  });
  releaseGroup(group);
}
