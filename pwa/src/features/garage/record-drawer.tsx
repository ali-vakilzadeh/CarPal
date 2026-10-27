'use client';
// W-GAR-02 record detail in a right drawer (640 px) over the history (C-GARAGE-04): work, date, mileage, the shop
// (links to its profile), category and task, description, parts, cost and its breakdown, warranty, evidence (preview
// in place, download), the verification mark with its explanation, the related appointment and the resolved issue.
// Actions: Add invoice or photos (always allowed, also on verified records; attached as each upload is clean), Edit /
// Delete only for records the user added, Book similar service, and Report a mistake on provider and appointment
// records (disputes.create service_record_dispute). Leave a review comes with P11.
import type { ServiceRecord, ServiceRecordEvidence, Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { TextField } from '@/components/ds/text-field';
import { SelectField } from '@/components/fields/select-field';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard } from '@/components/shell/skeleton';
import { useToast } from '@/components/shell/toast';
import { AssetThumb, DocumentPreview, DownloadButton, UploadZone } from '@/features/media';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useAttachWhenReady } from './attach';
import { useRecord, useRefresh } from './hooks';
import { canEditRecord, garagePath, isVerified, recordPath } from './model';
import { useNodeNames } from './names';

const VERIFICATION_TEXT: Record<ServiceRecord['verification_status'], MessageKey> = {
  self_reported: 'garage.record.why.self_reported',
  provider_confirmed: 'garage.record.why.provider_confirmed',
  appointment_verified: 'garage.record.why.appointment_verified',
  invoice_verified: 'garage.record.why.invoice_verified',
  admin_verified: 'garage.record.why.admin_verified',
};

export function RecordDrawer({
  vehicle: v,
  recordId,
  onClose,
  readOnly,
}: {
  vehicle: Vehicle;
  recordId: string | null;
  onClose: () => void;
  readOnly: boolean;
}) {
  const t = useT();
  const record = useRecord(v.id, recordId);
  const systems = useNodeNames('service_system');
  const title = record.data ? (systems.name(record.data.service_system_node_id) ?? t('garage.record.title')) : t('garage.record.title');
  return (
    <Dialog name="record" variant="panel" open={!!recordId} onClose={onClose} title={title}>
      {record.isPending ? <SkeletonCard lines={6} /> : null}
      {record.isError ? <ErrorState error={record.error} onRetry={() => void record.refetch()} compact /> : null}
      {record.data ? <RecordBody vehicle={v} record={record.data} onClose={onClose} readOnly={readOnly} /> : null}
    </Dialog>
  );
}

function RecordBody({
  vehicle: v,
  record: r,
  onClose,
  readOnly,
}: {
  vehicle: Vehicle;
  record: ServiceRecord;
  onClose: () => void;
  readOnly: boolean;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const { setActive } = useActiveVehicle();
  const tasks = useNodeNames('service_task', r.service_system_node_id);
  const systems = useNodeNames('service_system');
  const editable = canEditRecord(r) && !readOnly;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [dispute, setDispute] = useState(false);
  const group = `evidence:${r.id}`;

  const attach = useCallback(
    async (asset: { id: string; media_type: string }) => {
      await api.api('service_records.evidence_add', {
        path: { vehicle_id: v.id, record_id: r.id },
        body: { evidence_type: asset.media_type === 'document' ? 'invoice' : 'photo', media_asset_id: asset.id },
      });
      await refresh('service_records.get', 'service_records.list');
    },
    [api, refresh, v.id, r.id],
  );
  const { failed } = useAttachWhenReady(group, readOnly ? null : attach);

  const remove = async () => {
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await api.api('service_records.delete', { path: { vehicle_id: v.id, record_id: r.id } });
      await refresh('service_records.list', 'vehicles.get');
      toast(t('garage.record.deleted'));
      setConfirmDelete(false);
      onClose();
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  };

  const evidence = r.evidence.filter((e) => e.status === 'active' && e.media_asset_id);
  const breakdown = r.cost_breakdown ? Object.entries(r.cost_breakdown).filter(([, value]) => value) : [];
  return (
    <div className="flex flex-col gap-4" data-testid="record-detail">
      <div className="pwa-record-meta">
        {isVerified(r) ? (
          <Badge tone="success" icon="shield">
            {t('garage.record.verified')}
          </Badge>
        ) : (
          <Badge tone="neutral" icon="user">
            {t('garage.record.addedByYou')}
          </Badge>
        )}
        <span className="pwa-text-caption">{t(VERIFICATION_TEXT[r.verification_status])}</span>
      </div>
      {r.status === 'disputed' ? <Banner tone="warn" text={t('garage.record.disputed')} /> : null}
      <dl className="pwa-spec-list">
        <div>
          <dt className="pwa-text-caption">{t('garage.history.date')}</dt>
          <dd>{f.calendarDate(r.service_date, 'dateLong')}</dd>
        </div>
        {r.mileage_km !== undefined ? (
          <div>
            <dt className="pwa-text-caption">{t('garage.history.mileage')}</dt>
            <dd>{t('garage.mileageValue', { km: f.number(r.mileage_km) })}</dd>
          </div>
        ) : null}
        <div>
          <dt className="pwa-text-caption">{t('garage.history.category')}</dt>
          <dd dir="auto">{[systems.name(r.service_system_node_id), tasks.name(r.service_task_node_id)].filter(Boolean).join(' → ')}</dd>
        </div>
        {r.provider ? (
          <div>
            <dt className="pwa-text-caption">{t('garage.history.shop')}</dt>
            <dd dir="auto">
              {r.provider.slug ? (
                <Link
                  className="pwa-link"
                  href={`/${locale}/${r.provider.organization_type === 'vendor' ? 'parts-seller' : 'shop'}/${r.provider.slug}`}
                >
                  <bdi>{r.provider.name}</bdi>
                </Link>
              ) : (
                <bdi>{r.provider.name}</bdi>
              )}
            </dd>
          </div>
        ) : null}
        {r.cost ? (
          <div>
            <dt className="pwa-text-caption">{t('garage.history.cost')}</dt>
            <dd>
              {f.money(r.cost.amount, r.cost.currency)}
              {breakdown.length ? (
                <span className="pwa-text-caption">
                  {' '}
                  (
                  {breakdown
                    .map(
                      ([k, value]) =>
                        `${t(`garage.form.costPart.${k as 'labor' | 'parts' | 'tax' | 'other'}`)} ${f.money(value!, r.cost!.currency)}`,
                    )
                    .join(' · ')}
                  )
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {r.warranty_note ? (
          <div>
            <dt className="pwa-text-caption">{t('garage.form.warranty')}</dt>
            <dd dir="auto">{r.warranty_note}</dd>
          </div>
        ) : null}
      </dl>
      {r.description ? (
        <p className="pwa-text-body pwa-prewrap" dir="auto">
          {r.description}
        </p>
      ) : null}
      {r.parts_used?.length ? (
        <section aria-labelledby={`parts-${r.id}`}>
          <h3 id={`parts-${r.id}`} className="pwa-section-title">
            {t('garage.form.parts')}
          </h3>
          <ul className="pwa-bullets">
            {r.parts_used.map((p, i) => (
              <li key={i} dir="auto">
                {f.digits(p.quantity)} × {p.name}
                {p.part_number ? (
                  <>
                    {' · '}
                    <bdi dir="ltr">{p.part_number}</bdi>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.appointment_id || r.resolves_issue_id ? (
        <ul className="pwa-plain-list">
          {r.appointment_id ? (
            <li>
              <Link className="pwa-link" href={`/${locale}/appointments/${r.appointment_id}`}>
                {t('garage.record.appointment')}
              </Link>
            </li>
          ) : null}
          {r.resolves_issue_id ? (
            <li>
              <Link className="pwa-link" href={`${garagePath(locale, v.id, 'issues')}?modal=issue&issue=${r.resolves_issue_id}`}>
                {t('garage.record.resolvedIssue')}
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby={`evidence-${r.id}`}>
        <h3 id={`evidence-${r.id}`} className="pwa-section-title">
          {t('garage.record.evidence')}
        </h3>
        {evidence.length === 0 ? <p className="pwa-text-caption">{t('garage.record.noEvidence')}</p> : null}
        <ul className="pwa-evidence-list">
          {evidence.map((e) => (
            <EvidenceItem key={e.id} vehicleId={v.id} recordId={r.id} evidence={e} removable={editable} />
          ))}
        </ul>
        {!readOnly ? <UploadZone group={group} purpose="service_evidence" label={t('garage.record.addEvidence')} paste={false} /> : null}
        {failed > 0 ? <Banner tone="danger" text={t('garage.record.attachFailed')} /> : null}
      </section>

      <div className="pwa-inline-buttons">
        {editable ? (
          <Link href={recordPath(locale, v.id, r.id)} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <Icon name="edit" size={20} />
            <span className="cp-btn-label">{t('garage.edit')}</span>
          </Link>
        ) : null}
        <Link href={`/${locale}/search`} className={buttonClass({ variant: 'ghost', size: 'sm' })} onClick={() => setActive(v.id)}>
          <Icon name="calendar" size={20} />
          <span className="cp-btn-label">{t('garage.record.bookSimilar')}</span>
        </Link>
        {editable ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>
            {t('garage.record.delete')}
          </Button>
        ) : null}
        {!canEditRecord(r) && r.status === 'active' ? (
          <Button size="sm" variant="ghost" icon="flag" onClick={() => setDispute(true)}>
            {t('garage.record.reportMistake')}
          </Button>
        ) : null}
      </div>

      <Dialog
        name="record-delete"
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('garage.record.deleteTitle')}
        footer={
          <>
            <Button variant="danger" loading={deleting} onClick={() => void remove()}>
              {t('garage.record.delete')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('garage.record.deleteText')}</p>
        {deleteFailed ? <Banner tone="danger" text={t('garage.saveFailed')} /> : null}
      </Dialog>
      <DisputeDialog recordId={r.id} open={dispute} onClose={() => setDispute(false)} />
    </div>
  );
}

function EvidenceItem({
  vehicleId,
  recordId,
  evidence: e,
  removable,
}: {
  vehicleId: string;
  recordId: string;
  evidence: ServiceRecordEvidence;
  removable: boolean;
}) {
  const t = useT();
  const api = useApiClient();
  const refresh = useRefresh();
  const [preview, setPreview] = useState(false);
  const label = t(`garage.record.evidenceType.${e.evidence_type}`);
  const remove = async () => {
    await api
      .api('service_records.evidence_remove', { path: { vehicle_id: vehicleId, record_id: recordId, evidence_id: e.id } })
      .catch(() => undefined);
    await refresh('service_records.get', 'service_records.list');
  };
  return (
    <li className="pwa-evidence">
      <button type="button" className="pwa-evidence-open" onClick={() => setPreview(true)}>
        <AssetThumb mediaId={e.media_asset_id!} label={label} />
        <span>{label}</span>
      </button>
      <DownloadButton mediaId={e.media_asset_id!} name={label} size="sm" />
      {removable ? (
        <IconButton icon="trash" label={t('garage.record.removeEvidence', { name: label })} onClick={() => void remove()} />
      ) : null}
      <DocumentPreview mediaId={e.media_asset_id!} title={label} open={preview} onClose={() => setPreview(false)} />
    </li>
  );
}

const DISPUTE_REASONS = ['wrongVehicle', 'wrongDate', 'wrongWork', 'other'] as const;

function DisputeDialog({ recordId, open, onClose }: { recordId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const [kind, setKind] = useState<(typeof DISPUTE_REASONS)[number] | ''>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const send = async () => {
    const reason = [kind ? t(`garage.dispute.${kind}`) : '', text.trim()].filter(Boolean).join(': ');
    if (!kind || reason.length < 10) return setError('garage.dispute.tooShort');
    setBusy(true);
    setError(null);
    try {
      await api.api('disputes.create', {
        body: { target: { type: 'service_record', id: recordId }, dispute_type: 'service_record_dispute', reason: reason.slice(0, 2000) },
      });
      toast(t('garage.dispute.sent'));
      onClose();
    } catch {
      setError('garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      name="record-dispute"
      open={open}
      onClose={onClose}
      title={t('garage.record.reportMistake')}
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={() => void send()}>
            {t('garage.dispute.send')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </>
      }
    >
      <SelectField
        label={t('garage.dispute.what')}
        value={kind}
        onChange={(k) => setKind(k as typeof kind)}
        placeholder={t('garage.dispute.choose')}
        options={DISPUTE_REASONS.map((k) => ({ value: k, label: t(`garage.dispute.${k}`) }))}
      />
      <TextField
        multiline
        rows={3}
        label={t('garage.dispute.details')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={1000}
      />
      <p className="pwa-text-caption">{t('garage.dispute.hint')}</p>
      {error ? <Banner tone="danger" text={t(error)} /> : null}
    </Dialog>
  );
}
