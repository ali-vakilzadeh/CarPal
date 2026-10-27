'use client';
// W-GAR-01 Issues tab (C-GARAGE-02 Issues, C-GARAGE-06 in a side drawer on the web). Active and Resolved segments;
// a card shows title, urgency (icon + word), opened date, status and the linked appointment. Add issue (?modal=
// issue-add): title, what happens (≥ 10 characters, BA-29), urgency, photos or a short video (the upload kit). Get
// help and Find help open Help Me with this car and issue (/<locale>/help?vehicle&issue — P10 builds the wizard). The
// drawer (?modal=issue&issue=<id>): urgency, status timeline, description and media, the safety banner, Edit
// description (If-Match; 412 → reload without losing the text), Add photo, Mark as resolved (how: a shop on CarPal —
// with the service record —, elsewhere, or it went away) and Remove for issues the user reported.
import type { Vehicle, VehicleIssue } from '@carpal/api-contracts';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Urgency } from '@/components/ds/urgency';
import { SelectField } from '@/components/fields/select-field';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard, SkeletonList } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { UrlModal, useUrlModal } from '@/components/shell/url-modal';
import { AssetThumb, discardGroup, releaseGroup, UploadZone, uploadsOf, whenReady } from '@/features/media';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useAttachWhenReady } from './attach';
import { useIssue, useIssues, useRecords, useRefresh } from './hooks';
import { isActiveIssue, MIN_ISSUE_DESCRIPTION, urgencyStyle } from './model';
import { useNodeNames } from './names';

const URGENCIES = ['low', 'medium', 'high', 'safety_critical'] as const;

function helpHref(locale: string, vehicleId: string, issueId?: string) {
  return `/${locale}/help?${new URLSearchParams({ vehicle: vehicleId, ...(issueId ? { issue: issueId } : {}) }).toString()}`;
}

export function IssuesTab({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const locale = useLocale();
  const issues = useIssues(v.id);
  const add = useUrlModal('issue-add');
  const drawer = useUrlModal('issue', ['issue']);
  const [segment, setSegment] = useState<'active' | 'resolved'>('active');
  const all = issues.data?.items ?? [];
  const active = all.filter(isActiveIssue);
  const resolved = all.filter((i) => !isActiveIssue(i));
  const shown = segment === 'active' ? active : resolved;
  return (
    <div className="pwa-tab-stack">
      <div className="pwa-toolbar">
        {!readOnly ? (
          <>
            <Button size="sm" variant="primary" icon="plus" onClick={() => add.open()}>
              {t('garage.issues.add')}
            </Button>
            <Link href={helpHref(locale, v.id)} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <Icon name="help" size={20} />
              <span className="cp-btn-label">{t('garage.issues.getHelp')}</span>
            </Link>
          </>
        ) : null}
        <div className="pwa-segmented" role="group" aria-label={t('garage.issues.segments')}>
          <button
            type="button"
            className={cx('pwa-segment', segment === 'active' && 'is-active')}
            aria-pressed={segment === 'active'}
            onClick={() => setSegment('active')}
          >
            {t('garage.issues.active', { count: active.length })}
          </button>
          <button
            type="button"
            className={cx('pwa-segment', segment === 'resolved' && 'is-active')}
            aria-pressed={segment === 'resolved'}
            onClick={() => setSegment('resolved')}
          >
            {t('garage.issues.resolved', { count: resolved.length })}
          </button>
        </div>
      </div>
      {issues.isPending ? (
        <SkeletonList count={2} label={t('garage.loading')} />
      ) : issues.isError ? (
        <ErrorState error={issues.error} onRetry={() => void issues.refetch()} compact />
      ) : shown.length === 0 ? (
        <StateView
          kind="empty"
          t={t}
          compact
          title={t(segment === 'active' ? 'garage.issues.emptyActive' : 'garage.issues.emptyResolved')}
        />
      ) : (
        <ul className="pwa-card-list" data-testid="issue-list">
          {shown.map((i) => (
            <li key={i.id}>
              <IssueCard issue={i} onOpen={() => drawer.open({ issue: i.id })} />
            </li>
          ))}
        </ul>
      )}
      {!readOnly ? (
        <UrlModal control={add} title={t('garage.issues.add')} name="issue-add">
          <IssueForm
            vehicle={v}
            onDone={(id) => {
              add.close();
              if (id) setTimeout(() => drawer.open({ issue: id }), 0);
            }}
          />
        </UrlModal>
      ) : null}
      <IssueDrawer vehicle={v} issueId={drawer.isOpen ? drawer.params.get('issue') : null} onClose={drawer.close} readOnly={readOnly} />
    </div>
  );
}

function IssueCard({ issue: i, onOpen }: { issue: VehicleIssue; onOpen: () => void }) {
  const t = useT();
  const f = useFormat();
  return (
    <button type="button" className="pwa-issue-card" onClick={onOpen}>
      <span className="pwa-issue-card-head">
        <span className="pwa-choice-title" dir="auto">
          {i.title}
        </span>
        <Urgency level={urgencyStyle(i.urgency_level)} label={t(`garage.urgency.${i.urgency_level}`)} />
      </span>
      <span className="pwa-text-caption">
        {t('garage.issues.opened', { date: f.date(i.created_at) })} · {t(`garage.issues.status.${i.status}`)}
        {i.converted_appointment_id ? ` · ${t('garage.issues.hasAppointment')}` : ''}
      </span>
    </button>
  );
}

function IssueForm({ vehicle: v, onDone }: { vehicle: Vehicle; onDone: (issueId: string | null) => void }) {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const group = `issue:${v.id}:new`;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState<(typeof URGENCIES)[number]>('medium');
  const [errors, setErrors] = useState<Partial<Record<'title' | 'description', MessageKey>>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const e: typeof errors = {};
    if (title.trim().length < 3) e.title = 'garage.issues.errors.title';
    if (description.trim().length < MIN_ISSUE_DESCRIPTION) e.description = 'garage.issues.errors.description';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFormError(null);
    try {
      const assets = await Promise.all(
        uploadsOf(group)
          .filter((u) => u.state.phase !== 'failed')
          .map((u) => whenReady(u.id)),
      );
      const mediaIds = assets
        .filter((a) => a !== null)
        .map((a) => a.id)
        .slice(0, 10);
      const issue = await api.api('issues.create', {
        path: { vehicle_id: v.id },
        body: {
          title: title.trim().slice(0, 120),
          description: description.trim().slice(0, 3000),
          content_locale: locale === 'en' ? 'en' : 'fa',
          urgency_level: urgency,
          ...(mediaIds.length ? { media_ids: mediaIds } : {}),
        },
      });
      releaseGroup(group);
      await refresh('issues.list', 'vehicles.get', 'vehicles.list');
      toast(t('garage.issues.saved'));
      onDone(issue.id);
    } catch (err) {
      if (err instanceof ApiProblem && err.field('/description')) setErrors({ description: 'garage.issues.errors.description' });
      else setFormError(err instanceof ApiProblem && err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <TextField
        label={t('garage.issues.title')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        error={errors.title ? t(errors.title) : undefined}
      />
      <TextField
        multiline
        rows={4}
        label={t('garage.issues.description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={3000}
        hint={t('garage.issues.descriptionHint')}
        error={errors.description ? t(errors.description) : undefined}
      />
      <SelectField
        label={t('garage.issues.urgency')}
        value={urgency}
        onChange={(u) => setUrgency(u as (typeof URGENCIES)[number])}
        options={URGENCIES.map((u) => ({ value: u, label: t(`garage.urgency.${u}`) }))}
      />
      <UploadZone group={group} purpose="issue_photo" label={t('garage.issues.photos')} hint={t('garage.issues.photosHint')} />
      {formError ? <Banner tone="danger" text={t(formError)} /> : null}
      <div className="pwa-inline-buttons">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            discardGroup(group);
            onDone(null);
          }}
        >
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}

function IssueDrawer({
  vehicle: v,
  issueId,
  onClose,
  readOnly,
}: {
  vehicle: Vehicle;
  issueId: string | null;
  onClose: () => void;
  readOnly: boolean;
}) {
  const t = useT();
  const issue = useIssue(v.id, issueId);
  return (
    <Dialog name="issue" variant="panel" open={!!issueId} onClose={onClose} title={issue.data?.title ?? t('garage.issues.issue')}>
      {issue.isPending ? <SkeletonCard lines={5} /> : null}
      {issue.isError ? <ErrorState error={issue.error} onRetry={() => void issue.refetch()} compact /> : null}
      {issue.data ? <IssueBody vehicle={v} issue={issue.data} onReload={() => void issue.refetch()} readOnly={readOnly} /> : null}
    </Dialog>
  );
}

const RESOLUTIONS = ['shop', 'elsewhere', 'wentAway'] as const;

function IssueBody({
  vehicle: v,
  issue: i,
  onReload,
  readOnly,
}: {
  vehicle: Vehicle;
  issue: VehicleIssue;
  onReload: () => void;
  readOnly: boolean;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const symptoms = useNodeNames('symptom', null, !!i.symptom_node_id);
  const active = isActiveIssue(i);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(i.description);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolve, setResolve] = useState(false);
  const group = `issue:${v.id}:${i.id}`;

  const attach = useCallback(
    async (asset: { id: string }) => {
      const media = [...(i.media_ids ?? []), asset.id].slice(0, 10);
      await api.api('issues.update', { path: { vehicle_id: v.id, issue_id: i.id }, body: { media_ids: media } });
      await refresh('issues.get', 'issues.list');
    },
    [api, refresh, v.id, i.id, i.media_ids],
  );
  const { failed } = useAttachWhenReady(group, readOnly || !active ? null : attach);

  const saveText = async () => {
    if (text.trim().length < MIN_ISSUE_DESCRIPTION) return setError('garage.issues.errors.description');
    setBusy(true);
    setError(null);
    try {
      await api.api('issues.update', { path: { vehicle_id: v.id, issue_id: i.id }, body: { description: text.trim() } });
      await refresh('issues.get', 'issues.list');
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiProblem && err.versionMismatch) setError('garage.form.conflictText');
      else setError('garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const cancelIssue = async () => {
    setBusy(true);
    try {
      await api.api('issues.status_change', { path: { vehicle_id: v.id, issue_id: i.id }, body: { status: 'cancelled' } });
      await refresh('issues.get', 'issues.list', 'vehicles.get', 'vehicles.list');
      toast(t('garage.issues.removed'));
    } catch {
      setError('garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const steps: { key: MessageKey; at: string | null; done: boolean }[] = [
    { key: 'garage.issues.timeline.reported', at: i.created_at, done: true },
    { key: 'garage.issues.timeline.appointment', at: null, done: !!i.converted_appointment_id || i.status === 'scheduled' },
    { key: 'garage.issues.timeline.resolved', at: i.resolved_at, done: i.status === 'resolved' },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="issue-detail">
      {active && (i.urgency_level === 'safety_critical' || i.safety_flag) ? (
        <SafetyBanner
          title={t('garage.safety.title')}
          text={t('garage.safety.issueText')}
          action={
            <Link href={`/${locale}/help?urgent=1`} className={buttonClass({ variant: 'primary', size: 'sm' })}>
              <span className="cp-btn-label">{t('garage.safety.action')}</span>
            </Link>
          }
        />
      ) : null}
      <div className="pwa-record-meta">
        <Urgency level={urgencyStyle(i.urgency_level)} label={t(`garage.urgency.${i.urgency_level}`)} />
        <span className="pwa-text-caption">{t(`garage.issues.status.${i.status}`)}</span>
        {i.symptom_node_id ? <span className="pwa-text-caption">{symptoms.name(i.symptom_node_id)}</span> : null}
      </div>
      <ol className="pwa-issue-steps" aria-label={t('garage.issues.timeline.label')}>
        {steps.map((s) => (
          <li key={s.key} className={cx('pwa-issue-step', s.done && 'is-done')}>
            <Icon name={s.done ? 'check' : 'clock'} size={16} />
            {t(s.key)}
            {s.at ? <span className="pwa-text-caption"> · {f.date(s.at)}</span> : null}
          </li>
        ))}
      </ol>
      {editing ? (
        <div className="flex flex-col gap-3">
          <TextField
            multiline
            rows={4}
            label={t('garage.issues.description')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={3000}
          />
          {error === 'garage.form.conflictText' ? (
            <Banner tone="warn" text={t(error)}>
              <div className="pwa-banner-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    onReload();
                    setError(null);
                  }}
                >
                  {t('garage.form.reload')}
                </Button>
              </div>
            </Banner>
          ) : error ? (
            <Banner tone="danger" text={t(error)} />
          ) : null}
          <div className="pwa-inline-buttons">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void saveText()}>
              {t('common.actions.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="pwa-text-body pwa-prewrap" dir="auto">
          {i.description}
        </p>
      )}
      {i.media_ids?.length ? (
        <ul className="pwa-evidence-list" aria-label={t('garage.issues.photos')}>
          {i.media_ids.map((id) => (
            <li key={id}>
              <AssetThumb mediaId={id} label={t('garage.issues.photo')} />
            </li>
          ))}
        </ul>
      ) : null}
      {i.triage_session_id ? <p className="pwa-text-caption">{t('garage.issues.fromHelpMe')}</p> : null}
      {i.converted_appointment_id ? (
        <Link className="pwa-link" href={`/${locale}/appointments/${i.converted_appointment_id}`}>
          {t('garage.issues.linkedAppointment')}
        </Link>
      ) : null}
      {!readOnly && active ? (
        <>
          <UploadZone group={group} purpose="issue_photo" label={t('garage.issues.addPhoto')} paste={false} />
          {failed > 0 ? <Banner tone="danger" text={t('garage.record.attachFailed')} /> : null}
          <div className="pwa-inline-buttons">
            <Link href={helpHref(locale, v.id, i.id)} className={buttonClass({ variant: 'primary', size: 'sm' })}>
              <Icon name="help" size={20} />
              <span className="cp-btn-label">{t('garage.issues.findHelp')}</span>
            </Link>
            {!editing ? (
              <Button size="sm" variant="secondary" icon="edit" onClick={() => setEditing(true)}>
                {t('garage.issues.editDescription')}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" icon="check" onClick={() => setResolve(true)}>
              {t('garage.issues.markResolved')}
            </Button>
            {i.source === 'user' ? (
              <Button size="sm" variant="ghost" icon="trash" loading={busy && !editing} onClick={() => void cancelIssue()}>
                {t('garage.issues.remove')}
              </Button>
            ) : null}
          </div>
          {error && !editing ? <Banner tone="danger" text={t(error)} /> : null}
        </>
      ) : null}
      <ResolveDialog vehicle={v} issue={i} open={resolve} onClose={() => setResolve(false)} />
    </div>
  );
}

function ResolveDialog({
  vehicle: v,
  issue: i,
  open,
  onClose,
}: {
  vehicle: Vehicle;
  issue: VehicleIssue;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const records = useRecords(v.id);
  const systems = useNodeNames('service_system');
  const [how, setHow] = useState<(typeof RESOLUTIONS)[number]>('elsewhere');
  const [recordId, setRecordId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = (records.data?.pages ?? []).flatMap((p) => p.items).filter((r) => r.provider);
  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.api('issues.status_change', {
        path: { vehicle_id: v.id, issue_id: i.id },
        body: { status: 'resolved', ...(how === 'shop' && recordId ? { resolved_by_service_record_id: recordId } : {}) },
      });
      await refresh('issues.get', 'issues.list', 'vehicles.get', 'vehicles.list');
      toast(t('garage.issues.resolvedToast'));
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      name="issue-resolve"
      open={open}
      onClose={onClose}
      title={t('garage.issues.howResolved')}
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('garage.issues.markResolved')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </>
      }
    >
      <fieldset className="pwa-choice-list">
        <legend className="sr-only">{t('garage.issues.howResolved')}</legend>
        {RESOLUTIONS.map((r) => (
          <label key={r} className={cx('pwa-choice', how === r && 'is-selected')}>
            <input type="radio" name={`resolve-${i.id}`} value={r} checked={how === r} onChange={() => setHow(r)} />
            <span className="pwa-choice-title">{t(`garage.issues.resolution.${r}`)}</span>
          </label>
        ))}
      </fieldset>
      {how === 'shop' && list.length > 0 ? (
        <SelectField
          label={t('garage.issues.whichRecord')}
          value={recordId}
          onChange={setRecordId}
          placeholder={t('garage.issues.noRecord')}
          options={list.map((r) => ({
            value: r.id,
            label: `${f.calendarDate(r.service_date)} · ${systems.name(r.service_system_node_id) ?? ''} · ${r.provider?.name ?? ''}`,
          }))}
        />
      ) : null}
      {failed ? <Banner tone="danger" text={t('garage.saveFailed')} /> : null}
    </Dialog>
  );
}
