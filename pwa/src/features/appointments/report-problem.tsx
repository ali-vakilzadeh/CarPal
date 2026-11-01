'use client';
// W-APP-01 "Report a problem" (Docs/21 C-APP-02; P13.T9, DI-65): reports.create has no appointment target, so a
// problem with a visit is a mediation request (disputes.create, target appointment, dispute_type mediation_request —
// the only type the backend takes for appointments). The section shows the newest request about this appointment
// with its status and Withdraw while it is open; a second request while one is open answers 409 DUPLICATE.
import type { Appointment, Dispute } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { SelectField } from '@/components/fields/select-field';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

export const PROBLEM_REASONS = ['noShow', 'price', 'quality', 'conduct', 'other'] as const;
export type ProblemReason = (typeof PROBLEM_REASONS)[number];
/** disputes.create reason: ≥ 10 characters (backend), ≤ 2000 here. */
export const PROBLEM_MIN = 10;
export const PROBLEM_MAX = 2000;
const OPEN: ReadonlySet<Dispute['status']> = new Set(['open', 'in_mediation']);

/** A draft has not reached the shop, so there is nothing to mediate yet. */
export const canReportProblem = (a: Pick<Appointment, 'status'>) => a.status !== 'draft';

/** "<reason label>: <details>", as the mediator reads it. */
export function problemText(reasonLabel: string, details: string): string {
  return [reasonLabel, details.trim()].filter(Boolean).join(': ').slice(0, PROBLEM_MAX);
}

/** The newest request about this appointment (disputes.mine_list has no target filter). */
export function latestDispute(items: readonly Dispute[], appointmentId: string): Dispute | null {
  return (
    items
      .filter((d) => d.target.type === 'appointment' && d.target.id === appointmentId)
      .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0] ?? null
  );
}

export function ReportProblem({ appointment: a }: { appointment: Appointment }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const disputes = useApiQuery('disputes.mine_list', { query: { limit: 50 } }, { staleTime: 30_000, retry: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = latestDispute(disputes.data?.items ?? [], a.id);
  const active = current && OPEN.has(current.status) ? current : null;
  if (!canReportProblem(a)) return null;

  const withdraw = async (d: Dispute) => {
    setBusy(true);
    try {
      await api.api('disputes.withdraw', { path: { dispute_id: d.id } });
      toast(t('appointments.problem.withdrawn'));
      void disputes.refetch();
    } catch {
      toast(t('appointments.errors.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pwa-stack-sm" aria-labelledby="appt-problem" data-testid="appointment-problem">
      <h2 id="appt-problem" className="pwa-section-title">
        {t('appointments.problem.title')}
      </h2>
      <div className="pwa-card pwa-stack-sm">
        {current ? (
          <p className="pwa-text-body m-0" role="status">
            {t(`appointments.problem.status.${current.status}`, { date: f.date(current.created_at, 'date') })}
            {current.resolution ? (
              <>
                {' — '}
                <span className="pwa-user-text" dir="auto">
                  {current.resolution}
                </span>
              </>
            ) : null}
          </p>
        ) : (
          <p className="pwa-text-body m-0">{t('appointments.problem.text', { name: a.provider.name })}</p>
        )}
        <div className="pwa-inline-buttons">
          {active ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void withdraw(active)}>
              {t('appointments.problem.withdraw')}
            </Button>
          ) : (
            <Button size="sm" icon="flag" onClick={() => setOpen(true)}>
              {t('appointments.problem.button')}
            </Button>
          )}
        </div>
      </div>
      {open ? (
        <ProblemDialog
          appointmentId={a.id}
          onClose={() => setOpen(false)}
          onSent={() => {
            setOpen(false);
            void disputes.refetch();
          }}
        />
      ) : null}
    </section>
  );
}

function ProblemDialog({ appointmentId, onClose, onSent }: { appointmentId: string; onClose: () => void; onSent: () => void }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const [reason, setReason] = useState<ProblemReason | ''>('');
  const [details, setDetails] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const text = reason ? problemText(t(`appointments.problem.reason.${reason}`), details) : '';
  const short = [...details.trim()].length < PROBLEM_MIN;

  const send = async () => {
    setTried(true);
    if (!reason || short) return;
    setBusy(true);
    setError(null);
    try {
      await api.api('disputes.create', {
        body: { target: { type: 'appointment', id: appointmentId }, dispute_type: 'mediation_request', reason: text },
      });
      toast(t('appointments.problem.sent'));
      onSent();
    } catch (err) {
      setError(err instanceof ApiProblem && err.code === 'DUPLICATE' ? 'appointments.problem.duplicate' : 'appointments.errors.failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      name="appointment-problem"
      onClose={onClose}
      title={t('appointments.problem.dialogTitle')}
      footer={
        <div className="pwa-inline-buttons">
          <Button variant="primary" icon="send" loading={busy} onClick={() => void send()}>
            {t('appointments.problem.send')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <p className="pwa-text-body">{t('appointments.problem.dialogText')}</p>
      <SelectField
        label={t('appointments.problem.what')}
        value={reason}
        onChange={(v) => setReason(v as ProblemReason)}
        placeholder={t('appointments.problem.choose')}
        options={PROBLEM_REASONS.map((k) => ({ value: k, label: t(`appointments.problem.reason.${k}`) }))}
        error={tried && !reason ? t('appointments.problem.chooseError') : undefined}
      />
      <TextField
        multiline
        rows={4}
        label={t('appointments.problem.details')}
        value={details}
        maxLength={PROBLEM_MAX - 100}
        onChange={(e) => setDetails(e.target.value)}
        hint={t('appointments.problem.hint', { min: f.number(PROBLEM_MIN) })}
        error={tried && short ? t('appointments.problem.short', { min: f.number(PROBLEM_MIN) }) : undefined}
      />
      {error ? <Banner tone="danger" text={t(error)} /> : null}
    </Dialog>
  );
}
