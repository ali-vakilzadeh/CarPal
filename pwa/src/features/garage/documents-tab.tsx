'use client';
// W-GAR-01 Documents tab (W-GAR-02, C-GARAGE-02/07): a table sorted by nearest expiry (expired red, under 30 days
// amber, always with a word), each document with Preview (PDF in place, images full size), Download, Edit (title and
// dates) and Delete. Upload document (?modal=document-add): type, file (the upload kit: PDF or image, private and
// encrypted), title, issue and expiry dates, and "Remind me before expiry" (7, 14 or 30 days; default 14), which adds
// a document_expiry reminder after saving. "Documents are encrypted and only visible to you."
import type { Vehicle, VehicleDocument } from '@carpal/api-contracts';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { IconButton } from '@/components/ds/icon-button';
import { TextField } from '@/components/ds/text-field';
import { DateField } from '@/components/fields/date-field';
import { SelectField } from '@/components/fields/select-field';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { UrlModal, useUrlModal } from '@/components/shell/url-modal';
import {
  AssetThumb,
  discardGroup,
  DocumentPreview,
  DownloadButton,
  releaseGroup,
  UploadZone,
  useUploads,
  whenReady,
} from '@/features/media';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { addDaysIso, todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useDocuments, useItemEtag, useRefresh } from './hooks';
import { expiryTone, REMINDER_OFFSETS_DAYS, sortDocuments } from './model';

const DOC_TYPES = ['insurance', 'registration', 'warranty', 'invoice', 'inspection_report', 'other'] as const;
type DocType = (typeof DOC_TYPES)[number];

export function DocumentsTab({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const docs = useDocuments(v.id);
  const add = useUrlModal('document-add');
  const list = sortDocuments(docs.data?.items ?? []);
  return (
    <div className="pwa-tab-stack">
      <div className="pwa-toolbar">
        {!readOnly ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => add.open()}>
            {t('garage.documents.upload')}
          </Button>
        ) : null}
      </div>
      <p className="pwa-text-caption">{t('garage.documents.private')}</p>
      {docs.isPending ? (
        <SkeletonList count={2} label={t('garage.loading')} />
      ) : docs.isError ? (
        <ErrorState error={docs.error} onRetry={() => void docs.refetch()} compact />
      ) : list.length === 0 ? (
        <StateView kind="empty" t={t} compact title={t('garage.documents.emptyTitle')} text={t('garage.documents.emptyText')} />
      ) : (
        <div className="pwa-table-wrap">
          <table className="pwa-table pwa-table-stack" data-testid="documents-table">
            <caption className="sr-only">{t('garage.documents.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('garage.documents.type')}</th>
                <th scope="col">{t('garage.documents.title')}</th>
                <th scope="col">{t('garage.documents.issued')}</th>
                <th scope="col" aria-sort="ascending">
                  {t('garage.documents.expires')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('garage.documents.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <DocumentRow key={d.id} vehicle={v} doc={d} readOnly={readOnly} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!readOnly ? (
        <UrlModal control={add} title={t('garage.documents.upload')} name="document-add">
          <DocumentForm vehicle={v} onDone={add.close} />
        </UrlModal>
      ) : null}
    </div>
  );
}

function ExpiryCell({ doc }: { doc: VehicleDocument }) {
  const t = useT();
  const f = useFormat();
  const tone = expiryTone(doc.expires_at, todayIso(f.timeZone));
  if (tone === 'none') return <span className="pwa-text-caption">{t('garage.documents.noExpiry')}</span>;
  return (
    <span className="pwa-expiry">
      <span className="pwa-nowrap">{f.calendarDate(doc.expires_at!)}</span>
      {tone === 'expired' ? (
        <Badge tone="danger" icon="alert">
          {t('garage.documents.expired')}
        </Badge>
      ) : tone === 'soon' ? (
        <Badge tone="signal" icon="clock">
          {t('garage.documents.expiresSoon')}
        </Badge>
      ) : null}
    </span>
  );
}

function DocumentRow({ vehicle: v, doc: d, readOnly }: { vehicle: Vehicle; doc: VehicleDocument; readOnly: boolean }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const [preview, setPreview] = useState(false);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.api('vehicles.document_delete', { path: { vehicle_id: v.id, document_id: d.id } });
      await refresh('vehicles.documents_list', 'vehicles.get');
      toast(t('garage.documents.deleted'));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid="document-row">
      <td data-label={t('garage.documents.type')}>
        <span className="pwa-doc-type">
          <AssetThumb mediaId={d.media_asset_id} label={t(`garage.documents.types.${d.document_type}`)} />
          {t(`garage.documents.types.${d.document_type}`)}
        </span>
      </td>
      <td data-label={t('garage.documents.title')} dir="auto">
        {d.title}
      </td>
      <td data-label={t('garage.documents.issued')} className="pwa-nowrap">
        {d.issued_at ? f.calendarDate(d.issued_at) : '—'}
      </td>
      <td data-label={t('garage.documents.expires')}>
        <ExpiryCell doc={d} />
      </td>
      <td className="pwa-row-actions">
        <Button size="sm" variant="ghost" icon="eye" onClick={() => setPreview(true)}>
          {t('garage.documents.preview')}
        </Button>
        <DownloadButton mediaId={d.media_asset_id} name={d.title} size="sm" />
        {!readOnly ? (
          <>
            <IconButton icon="edit" label={t('garage.documents.edit', { name: d.title })} onClick={() => setEdit(true)} />
            <IconButton icon="trash" label={t('garage.documents.delete', { name: d.title })} onClick={() => setConfirm(true)} />
          </>
        ) : null}
        <DocumentPreview mediaId={d.media_asset_id} title={d.title} open={preview} onClose={() => setPreview(false)} />
        <Dialog name="document-edit" open={edit} onClose={() => setEdit(false)} title={t('garage.documents.editTitle')}>
          {edit ? <DocumentEdit vehicle={v} doc={d} onDone={() => setEdit(false)} /> : null}
        </Dialog>
        <Dialog
          name="document-delete"
          open={confirm}
          onClose={() => setConfirm(false)}
          title={t('garage.documents.deleteTitle')}
          footer={
            <>
              <Button variant="danger" loading={busy} onClick={() => void remove()}>
                {t('garage.documents.deleteConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                {t('common.actions.cancel')}
              </Button>
            </>
          }
        >
          <p className="pwa-text-body">{t('garage.documents.deleteText')}</p>
        </Dialog>
      </td>
    </tr>
  );
}

function DocumentForm({ vehicle: v, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const group = `document:${v.id}`;
  const uploads = useUploads(group);
  const [type, setType] = useState<DocType | ''>('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [issued, setIssued] = useState('');
  const [expires, setExpires] = useState('');
  const [remind, setRemind] = useState(true);
  const [offset, setOffset] = useState<number>(14);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = uploads.find((u) => u.state.phase !== 'failed') ?? null;
  const waiting = busy && upload && upload.state.phase !== 'ready';

  const save = async () => {
    setError(null);
    if (!type) return setError('garage.documents.errors.type');
    if (!upload) return setError('garage.documents.errors.file');
    if (title.trim().length < 2) return setError('garage.documents.errors.title');
    if (issued && expires && expires < issued) return setError('garage.documents.errors.dates');
    setBusy(true);
    try {
      const asset = await whenReady(upload.id);
      if (!asset) return setError('garage.documents.errors.upload');
      let created = false;
      for (let attempt = 0; !created; attempt++) {
        try {
          await api.api('vehicles.document_create', {
            path: { vehicle_id: v.id },
            body: {
              document_type: type,
              title: title.trim().slice(0, 120),
              media_asset_id: asset.id,
              visibility: 'private',
              ...(issued ? { issued_at: issued } : {}),
              ...(expires ? { expires_at: expires } : {}),
            },
          });
          created = true;
        } catch (err) {
          // The scan just finished: the document service may still see it as not ready for a moment.
          if (err instanceof ApiProblem && err.code === 'MEDIA_NOT_READY' && attempt < 3) await new Promise((r) => setTimeout(r, 1_000));
          else throw err;
        }
      }
      releaseGroup(group);
      if (expires && remind) {
        const today = todayIso(f.timeZone);
        const due = addDaysIso(expires, -offset);
        await api
          .api('reminders.create', {
            path: { vehicle_id: v.id },
            body: {
              reminder_type: 'document_expiry',
              title: t('garage.documents.reminderTitle', { title: title.trim() }).slice(0, 120),
              due_by_date: due < today ? today : due,
              priority: 'medium',
            },
          })
          .catch(() => toast(t('garage.documents.reminderFailed')));
      }
      await refresh('vehicles.documents_list', 'reminders.list', 'vehicles.get', 'vehicles.list');
      toast(t('garage.documents.saved'));
      onDone();
    } catch (err) {
      setError(err instanceof ApiProblem && err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label={t('garage.documents.type')}
        value={type}
        onChange={(v2) => {
          setType(v2 as DocType);
          // A title from the type until the user writes one.
          if (v2 && !titleTouched) setTitle(t(`garage.documents.types.${v2 as DocType}`));
        }}
        placeholder={t('garage.documents.chooseType')}
        options={DOC_TYPES.map((d) => ({ value: d, label: t(`garage.documents.types.${d}`) }))}
      />
      <UploadZone group={group} purpose="vehicle_document" label={t('garage.documents.file')} multiple={false} />
      <TextField
        label={t('garage.documents.title')}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setTitleTouched(true);
        }}
        maxLength={120}
      />
      <DateField label={t('garage.documents.issueDate')} value={issued} onChange={setIssued} optional />
      <DateField
        label={t('garage.documents.expiryDate')}
        value={expires}
        onChange={setExpires}
        optional
        max={addDaysIso(todayIso(f.timeZone), 365 * 30)}
      />
      {expires ? (
        <div className="flex flex-col gap-2">
          <Check checked={remind} onChange={(e) => setRemind(e.target.checked)}>
            {t('garage.documents.remind')}
          </Check>
          {remind ? (
            <SelectField
              label={t('garage.documents.remindWhen')}
              value={String(offset)}
              onChange={(o) => setOffset(Number(o))}
              options={REMINDER_OFFSETS_DAYS.map((n) => ({ value: String(n), label: t('garage.documents.daysBefore', { count: n }) }))}
            />
          ) : null}
        </div>
      ) : null}
      <p className="pwa-text-caption">{t('garage.documents.private')}</p>
      {waiting ? (
        <p className="pwa-text-caption" role="status">
          {t('garage.documents.waiting')}
        </p>
      ) : null}
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <div className="pwa-inline-buttons">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            discardGroup(group);
            onDone();
          }}
        >
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}

function DocumentEdit({ vehicle: v, doc: d, onDone }: { vehicle: Vehicle; doc: VehicleDocument; onDone: () => void }) {
  const t = useT();
  const api = useApiClient();
  const refresh = useRefresh();
  const etagOf = useItemEtag();
  const [title, setTitle] = useState(d.title);
  const [issued, setIssued] = useState(d.issued_at ?? '');
  const [expires, setExpires] = useState(d.expires_at ?? '');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (title.trim().length < 2) return setError('garage.documents.errors.title');
    setBusy(true);
    setError(null);
    try {
      await api.api('vehicles.document_update', {
        path: { vehicle_id: v.id, document_id: d.id },
        body: { title: title.trim(), ...(issued ? { issued_at: issued } : {}), ...(expires ? { expires_at: expires } : {}) },
        ifMatch: etagOf(`/v1/me/vehicles/${v.id}/documents/${d.id}`, d.version),
      });
      await refresh('vehicles.documents_list');
      onDone();
    } catch (err) {
      if (err instanceof ApiProblem && err.versionMismatch) {
        await refresh('vehicles.documents_list');
        setError('garage.form.conflictText');
      } else setError('garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <TextField label={t('garage.documents.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <DateField label={t('garage.documents.issueDate')} value={issued} onChange={setIssued} optional />
      <DateField label={t('garage.documents.expiryDate')} value={expires} onChange={setExpires} optional />
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <div className="pwa-inline-buttons">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}
