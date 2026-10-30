'use client';
// W-SET-01 Data & account (mirrors C-PROF-07; P9.T4, BA-30, Docs/40 §6.5): Download my data (an export request; its
// status; when it is ready, a download through a 5-minute signed link — the file itself is kept for 7 days — of one
// CSV in long format: section, record_id, field, value), Correct my data (a rectification request with what to fix),
// Delete account (what is deleted and what stays anonymous, then a typed confirmation; a deletion request), the
// request history, and organization memberships with Leave. Requests, downloads and leaving are AAL2: they go through
// the step-up and are repeated after it. Staff carry requests out on the admin plane (backend GD-29), so a new request
// shows as received until then. Deactivation has no operation and is not offered (DI-55).
import type { DataSubjectRequest, Membership } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useIntentHandler } from '@/components/shell/auth-intent';
import { Dialog } from '@/components/shell/dialog';
import { useStepUp } from '@/components/shell/step-up';
import { useToast } from '@/components/shell/toast';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { ApiProblem } from '@/lib/api/problem';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { deletionConfirmed, isOpen, latestRequest } from './model';
import { Card, ErrorLine, ReadState } from './parts';

export const DSR_TYPE: Record<DataSubjectRequest['request_type'], MessageKey> = {
  export: 'settings.data.type.export',
  deletion: 'settings.data.type.deletion',
  rectification: 'settings.data.type.rectification',
  consent_withdrawal: 'settings.data.type.consent_withdrawal',
};

export const DSR_STATUS: Record<DataSubjectRequest['status'], { key: MessageKey; tone: BadgeTone }> = {
  received: { key: 'settings.data.status.received', tone: 'neutral' },
  verifying_identity: { key: 'settings.data.status.verifying_identity', tone: 'signal' },
  in_progress: { key: 'settings.data.status.in_progress', tone: 'signal' },
  completed: { key: 'settings.data.status.completed', tone: 'success' },
  rejected: { key: 'settings.data.status.rejected', tone: 'danger' },
};

export function DsrStatus({ r }: { r: DataSubjectRequest }) {
  const t = useT();
  return <Badge tone={DSR_STATUS[r.status].tone}>{t(DSR_STATUS[r.status].key)}</Badge>;
}

const DSR_ARGS = { query: { limit: 50 } } as const;

function useDsr() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['dsr.list'] });
  type Draft = { request_type: DataSubjectRequest['request_type']; details?: string };
  const create = (draft: Draft) => api.api('dsr.create', { body: draft });
  return {
    refresh,
    create: (draft: Draft, label: string) =>
      stepUp<DataSubjectRequest, Draft>({ type: 'settings.dsr_create', draft, label, run: () => create(draft) }),
    replayCreate: create,
    download: (id: string, label: string) =>
      stepUp<{ url: string }, { request_id: string }>({
        type: 'settings.dsr_download',
        target: id,
        draft: { request_id: id },
        label,
        run: () => api.api('dsr.export_download', { path: { request_id: id } }),
      }),
    replayDownload: (id: string) => api.api('dsr.export_download', { path: { request_id: id } }),
  };
}

function ExportCard({ requests }: { requests: readonly DataSubjectRequest[] }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const dsr = useDsr();
  const [busy, setBusy] = useState<'create' | 'download' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = latestRequest(requests, 'export');
  const open = latest && isOpen(latest);

  const request = async () => {
    setBusy('create');
    setError(null);
    try {
      const r = await dsr.create({ request_type: 'export' }, t('settings.stepUp.export'));
      if (r.steppingUp) return;
      dsr.refresh();
      toast(t('settings.data.exportRequested'));
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'DUPLICATE') dsr.refresh();
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const download = async (id: string) => {
    setBusy('download');
    setError(null);
    try {
      const r = await dsr.download(id, t('settings.stepUp.download'));
      if (!r.steppingUp) goTo(r.value.url);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('settings.data.exportTitle')} text={t('settings.data.exportText')}>
      {latest ? (
        <div className="pwa-settings-item" data-testid="export-status">
          <div className="pwa-stack-xs">
            <span className="pwa-text-label">{t('settings.data.requestedOn', { date: f.date(latest.requested_at) })}</span>
            <span className="pwa-text-caption">
              {latest.status === 'completed'
                ? latest.export_available
                  ? t('settings.data.ready')
                  : t('settings.data.expired')
                : latest.status === 'rejected'
                  ? t('settings.data.rejected', { reason: latest.rejection_reason ?? '—' })
                  : t('settings.data.dueBy', { date: f.date(latest.due_at) })}
            </span>
          </div>
          <DsrStatus r={latest} />
        </div>
      ) : null}
      <p className="pwa-text-caption m-0">{t('settings.data.csvNote')}</p>
      <div className="pwa-inline-buttons">
        {latest?.status === 'completed' && latest.export_available ? (
          <Button size="sm" variant="primary" icon="download" loading={busy === 'download'} onClick={() => void download(latest.id)}>
            {t('settings.data.download')}
          </Button>
        ) : null}
        {open ? null : (
          <Button size="sm" icon="doc" loading={busy === 'create'} onClick={() => void request()}>
            {latest ? t('settings.data.newExport') : t('settings.data.requestExport')}
          </Button>
        )}
      </div>
      {latest?.status === 'completed' && latest.export_available ? (
        <p className="pwa-text-caption m-0">{t('settings.data.linkNote')}</p>
      ) : null}
      <ErrorLine error={error} />
    </Card>
  );
}

function CorrectionCard({ requests }: { requests: readonly DataSubjectRequest[] }) {
  const t = useT();
  const toast = useToast();
  const dsr = useDsr();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = latestRequest(requests, 'rectification');
  const blocked = pending !== null && isOpen(pending);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await dsr.create({ request_type: 'rectification', details: details.trim() }, t('settings.stepUp.request'));
      if (r.steppingUp) return;
      setOpen(false);
      setDetails('');
      dsr.refresh();
      toast(t('settings.data.requestReceived'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('settings.data.correctTitle')} text={t('settings.data.correctText')}>
      {open ? (
        <div className="pwa-stack-sm">
          <TextField
            multiline
            rows={4}
            label={t('settings.data.correctLabel')}
            value={details}
            maxLength={2000}
            onChange={(e) => setDetails(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button variant="primary" loading={busy} disabled={details.trim().length < 5} onClick={() => void send()}>
              {t('settings.data.sendRequest')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="pwa-inline-buttons">
          <Button size="sm" icon="edit" disabled={blocked} onClick={() => setOpen(true)}>
            {t('settings.data.correctTitle')}
          </Button>
          {blocked ? <span className="pwa-text-caption">{t('settings.data.alreadyOpen')}</span> : null}
        </div>
      )}
    </Card>
  );
}

function DeletionCard({ requests }: { requests: readonly DataSubjectRequest[] }) {
  const t = useT();
  const toast = useToast();
  const dsr = useDsr();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const word = t('settings.data.deleteWord');
  const pending = latestRequest(requests, 'deletion');
  const blocked = pending !== null && isOpen(pending);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await dsr.create({ request_type: 'deletion' }, t('settings.stepUp.delete'));
      if (r.steppingUp) return;
      setOpen(false);
      setTyped('');
      dsr.refresh();
      toast(t('settings.data.deletionRequested'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('settings.data.deleteTitle')} text={t('settings.data.deleteText')}>
      <div className="pwa-inline-buttons">
        <Button size="sm" variant="danger" icon="trash" disabled={blocked} onClick={() => setOpen(true)}>
          {t('settings.data.deleteTitle')}
        </Button>
        {blocked ? <span className="pwa-text-caption">{t('settings.data.deletionOpen')}</span> : null}
      </div>
      <Dialog
        name="delete-account"
        open={open}
        onClose={() => (setOpen(false), setTyped(''))}
        title={t('settings.data.deleteConfirmTitle')}
        footer={
          <>
            <Button variant="danger" loading={busy} disabled={!deletionConfirmed(typed, word)} onClick={() => void confirm()}>
              {t('settings.data.deleteConfirm')}
            </Button>
            <Button variant="ghost" onClick={() => (setOpen(false), setTyped(''))}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <div className="pwa-stack-sm">
          <p className="pwa-text-label m-0">{t('settings.data.deletedTitle')}</p>
          <ul className="pwa-bullets">
            <li>{t('settings.data.deleted.account')}</li>
            <li>{t('settings.data.deleted.garage')}</li>
            <li>{t('settings.data.deleted.notifications')}</li>
            <li>{t('settings.data.deleted.unpublished')}</li>
          </ul>
          <p className="pwa-text-label m-0">{t('settings.data.keptTitle')}</p>
          <ul className="pwa-bullets">
            <li>{t('settings.data.kept.reviews')}</li>
            <li>{t('settings.data.kept.records')}</li>
          </ul>
          <p className="pwa-text-body m-0">{t('settings.data.exportFirst')}</p>
          <TextField
            label={t('settings.data.typeToConfirm', { word })}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          <ErrorLine error={error} />
        </div>
      </Dialog>
    </Card>
  );
}

function RequestsCard({ requests }: { requests: readonly DataSubjectRequest[] }) {
  const t = useT();
  const f = useFormat();
  if (!requests.length) return null;
  return (
    <Card title={t('settings.data.historyTitle')}>
      <div className="pwa-table-wrap">
        <table className="pwa-table pwa-table-stack" data-testid="dsr-table">
          <caption className="sr-only">{t('settings.data.historyTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('settings.data.colType')}</th>
              <th scope="col">{t('settings.data.colRequested')}</th>
              <th scope="col">{t('settings.data.colStatus')}</th>
              <th scope="col">{t('settings.data.colDue')}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td data-label={t('settings.data.colType')}>{t(DSR_TYPE[r.request_type])}</td>
                <td data-label={t('settings.data.colRequested')}>{f.date(r.requested_at)}</td>
                <td data-label={t('settings.data.colStatus')}>
                  <DsrStatus r={r} />
                  {r.rejection_reason ? (
                    <span className="block pwa-text-caption" dir="auto">
                      {r.rejection_reason}
                    </span>
                  ) : null}
                </td>
                <td data-label={t('settings.data.colDue')}>{f.date(r.completed_at ?? r.due_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const ROLE_GROUP = (role: Membership['role']): MessageKey => {
  if (role.endsWith('_owner')) return 'settings.data.role.owner';
  if (role.endsWith('_manager') || role === 'fleet_maintenance_coordinator') return 'settings.data.role.manager';
  if (role === 'fleet_driver') return 'settings.data.role.driver';
  return 'settings.data.role.member';
};

function MembershipsCard() {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const list = useApiQuery('me.memberships_list', { query: { limit: 50 } });
  const [leaving, setLeaving] = useState<Membership | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['me.memberships_list'] });
    void queryClient.invalidateQueries({ queryKey: ['me.get'] });
  };
  const leave = async (m: Membership) => {
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp<unknown, { membership_id: string }>({
        type: 'settings.membership_leave',
        target: m.id,
        draft: { membership_id: m.id },
        label: t('settings.stepUp.leave'),
        run: () => api.api('me.membership_leave', { path: { membership_id: m.id } }),
      });
      if (r.steppingUp) return;
      setLeaving(null);
      refresh();
      toast(t('settings.data.left', { name: m.organization?.name ?? '' }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  useIntentHandler<{ membership_id: string }>('settings.membership_leave', async (intent) => {
    if (!intent.draft?.membership_id) return;
    await api.api('me.membership_leave', { path: { membership_id: intent.draft.membership_id } });
    refresh();
    return t('settings.data.leftOne');
  });

  const orgs = (list.data?.items ?? []).filter((m) => m.organization && (m.status === 'active' || m.status === 'invited'));
  const lastOwner = error instanceof ApiProblem && error.code === 'INVALID_TRANSITION';
  return (
    <Card title={t('settings.data.orgsTitle')} text={t('settings.data.orgsText')}>
      {list.data ? null : <ReadState status={list.status} error={list.error} refetch={list.refetch} />}
      {list.data && orgs.length === 0 ? <p className="pwa-text-body m-0">{t('settings.data.noOrgs')}</p> : null}
      {orgs.length ? (
        <ul className="pwa-settings-list">
          {orgs.map((m) => (
            <li key={m.id} className="pwa-settings-item">
              <div className="pwa-stack-xs">
                <span className="pwa-text-label" dir="auto">
                  {m.organization!.name}
                </span>
                <span className="pwa-text-caption">
                  {t(ROLE_GROUP(m.role))}
                  {m.status === 'invited' ? ` · ${t('settings.data.invited')}` : ''}
                </span>
              </div>
              <Button size="sm" variant="ghost" icon="logout" onClick={() => (setLeaving(m), setError(null))}>
                {t('settings.data.leave')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        name="leave-org"
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        title={t('settings.data.leaveTitle', { name: leaving?.organization?.name ?? '' })}
        footer={
          <>
            <Button variant="danger" loading={busy} onClick={() => leaving && void leave(leaving)}>
              {t('settings.data.leave')}
            </Button>
            <Button variant="ghost" onClick={() => setLeaving(null)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('settings.data.leaveText')}</p>
        {lastOwner ? (
          <p className="pwa-error-text" role="alert">
            {t('settings.data.lastOwner')}
          </p>
        ) : (
          <ErrorLine error={error} />
        )}
      </Dialog>
    </Card>
  );
}

export function DataSection() {
  const t = useT();
  const dsr = useDsr();
  const requests = useApiQuery('dsr.list', DSR_ARGS, { staleTime: 15_000 });
  // After the step-up: file the request or start the download that was asked for.
  useIntentHandler<{ request_type: DataSubjectRequest['request_type']; details?: string }>('settings.dsr_create', async (intent) => {
    if (!intent.draft?.request_type) return;
    try {
      await dsr.replayCreate(intent.draft);
    } catch (err) {
      if (!(err instanceof ApiProblem && err.code === 'DUPLICATE')) throw err;
    }
    dsr.refresh();
    return t(intent.draft.request_type === 'export' ? 'settings.data.exportRequested' : 'settings.data.requestReceived');
  });
  useIntentHandler<{ request_id: string }>('settings.dsr_download', async (intent) => {
    if (!intent.draft?.request_id) return;
    goTo((await dsr.replayDownload(intent.draft.request_id)).url);
  });
  const items = requests.data?.items ?? [];
  return (
    <div className="pwa-stack">
      {requests.data ? null : <ReadState status={requests.status} error={requests.error} refetch={requests.refetch} />}
      <ExportCard requests={items} />
      <CorrectionCard requests={items} />
      <RequestsCard requests={items} />
      <MembershipsCard />
      <DeletionCard requests={items} />
    </div>
  );
}
