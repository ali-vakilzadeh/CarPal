'use client';
// AC14-2 parts of A-DSP-01 (backend S20, BR-15/BR-28/BR-30): the disputed record as a typed snapshot when it is not a
// Path 2 review (the moderation action under appeal with who decided it — staff only —, a service record, a badge, an
// appointment, or "no longer exists"), the other party (respondent) and the message threads with each side
// (admin.dispute_messages_list / admin.dispute_message_post): staff messages are written from a template, sent as
// "CarPal" (staff names never reach the parties), may ask for an answer by a day (at most 30 days ahead), and the first
// message to the respondent lets the other party of the target read and answer its thread.
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type {
  DisputeMessageTemplate,
  DisputeSide,
  DisputeTargetSnapshot,
  StaffDisputeDetail,
  StaffDisputeMessage,
} from '@carpal/api-contracts';
import { EntityChip, ReasonDialog, useAdminAction, ActionNotice } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { ACTION_TYPES, badgeName, badgeStatus, enumLabel } from '@/features/moderation';
import { APPOINTMENT_STATUSES } from '@/features/users';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

export const DISPUTE_SIDES: readonly DisputeSide[] = ['raiser', 'respondent'];
export const MESSAGE_TEMPLATES: readonly DisputeMessageTemplate[] = [
  'request_information',
  'request_evidence',
  'mediation_invitation',
  'status_update',
  'withdrawal_confirmation',
  'outcome_notice',
  'other',
];
export const MESSAGE_MAX = 2000;
export const REPLY_DUE_MAX_DAYS = 30;

const SERVICE_SOURCES = ['user_manual', 'provider_logged', 'appointment_completed', 'invoice_upload'] as const;
const SERVICE_VERIFICATION = ['self_reported', 'provider_confirmed', 'appointment_verified', 'invoice_verified', 'admin_verified'] as const;
const SERVICE_STATUSES = ['active', 'disputed', 'removed'] as const;

/** A day (yyyy-mm-dd) from today up to 30 days ahead, as the end of that day in UTC; null if outside. */
export function replyDueIso(day: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const end = Date.parse(`${day}T23:59:59Z`);
  if (Number.isNaN(end) || end <= now || end > now + REPLY_DUE_MAX_DAYS * 86_400_000) return null;
  return new Date(end).toISOString();
}

/** The message problem: required, or too long. */
export function messageProblem(text: string): 'required' | 'too_long' | null {
  const s = text.trim();
  if (!s) return 'required';
  return s.length > MESSAGE_MAX ? 'too_long' : null;
}

/** The disputed record as staff see it (non-review targets, or a review that is not on Path 2). */
export function DisputeTarget({ snapshot }: { snapshot: DisputeTargetSnapshot }) {
  const t = useT();
  const f = useFormat();
  if (!snapshot.available)
    return (
      <p className="adm-muted" data-testid="dispute-target-gone">
        {t('admin.disputes.snapshot.gone')}
      </p>
    );
  return (
    <section className="adm-panel" data-testid="dispute-target" aria-labelledby="dispute-target-t">
      <h3 id="dispute-target-t" className="adm-subtitle">
        {t('admin.disputes.snapshot.title')}
      </h3>
      <dl className="adm-facts">
        {snapshot.type === 'moderation_action' ? (
          <>
            <div>
              <dt>{t('admin.disputes.snapshot.action')}</dt>
              <dd>{enumLabel(ACTION_TYPES, 'admin.moderation.actionType', snapshot.action_type, t)}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.actionReason')}</dt>
              <dd>
                <Bidi>{snapshot.reason}</Bidi>
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.decidedBy')}</dt>
              <dd data-testid="snapshot-decider">
                <Bidi>{snapshot.decided_by_display}</Bidi> <span className="adm-muted">{t('admin.disputes.snapshot.staffOnly')}</span>
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.on')}</dt>
              <dd>
                {f.date(snapshot.created_at, 'dateTime')}
                {snapshot.moderation_case_id ? (
                  <>
                    {' '}
                    <EntityChip type="case" id={snapshot.moderation_case_id} />
                  </>
                ) : null}
              </dd>
            </div>
          </>
        ) : null}
        {snapshot.type === 'service_record' ? (
          <>
            <div>
              <dt>{t('admin.disputes.snapshot.serviceDate')}</dt>
              <dd>{f.date(snapshot.service_date, 'dateShort')}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.provider')}</dt>
              <dd>{snapshot.provider ? <Bidi>{snapshot.provider.name}</Bidi> : '—'}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.description')}</dt>
              <dd>{snapshot.description ? <Bidi>{snapshot.description}</Bidi> : '—'}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.mileage')}</dt>
              <dd>{snapshot.mileage_km == null ? '—' : t('admin.disputes.snapshot.km', { n: f.number(snapshot.mileage_km) })}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.source')}</dt>
              <dd>{enumLabel(SERVICE_SOURCES, 'admin.disputes.snapshot.sources', snapshot.source_type, t)}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.confirmation')}</dt>
              <dd>{enumLabel(SERVICE_VERIFICATION, 'admin.disputes.snapshot.verification', snapshot.verification_status, t)}</dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.status')}</dt>
              <dd>{enumLabel(SERVICE_STATUSES, 'admin.disputes.snapshot.serviceStatus', snapshot.status, t)}</dd>
            </div>
          </>
        ) : null}
        {snapshot.type === 'badge' ? (
          <>
            <div>
              <dt>{t('admin.disputes.snapshot.badge')}</dt>
              <dd>
                {badgeName(snapshot.badge_type, t)} · {badgeStatus(snapshot.status, t)}
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.organization')}</dt>
              <dd>
                <EntityChip type="organization" id={snapshot.organization.id} label={snapshot.organization.name} />
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.rule')}</dt>
              <dd>
                <Bidi ltr>{`${snapshot.rule_key} ${snapshot.rule_version}`}</Bidi>
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.awarded')}</dt>
              <dd>{f.date(snapshot.awarded_at, 'dateShort')}</dd>
            </div>
            {snapshot.revoked_reason ? (
              <div>
                <dt>{t('admin.disputes.snapshot.revokedReason')}</dt>
                <dd>
                  <Bidi>{snapshot.revoked_reason}</Bidi>
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
        {snapshot.type === 'appointment' ? (
          <>
            <div>
              <dt>{t('admin.disputes.snapshot.provider')}</dt>
              <dd>
                <EntityChip type="organization" id={snapshot.provider.id} label={snapshot.provider.name} />
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.status')}</dt>
              <dd>{enumLabel(APPOINTMENT_STATUSES, 'admin.users.appointments.status', snapshot.status, t)}</dd>
            </div>
            <div>
              <dt>{t('admin.users.appointments.col.confirmed')}</dt>
              <dd>{snapshot.confirmed_start_at ? f.date(snapshot.confirmed_start_at, 'dateTime') : '—'}</dd>
            </div>
            <div>
              <dt>{t('admin.users.appointments.col.completed')}</dt>
              <dd>{snapshot.completed_at ? f.date(snapshot.completed_at, 'dateShort') : '—'}</dd>
            </div>
          </>
        ) : null}
        {snapshot.type === 'review' ? (
          <>
            <div>
              <dt>{t('admin.disputes.snapshot.review')}</dt>
              <dd>
                {snapshot.title ? <Bidi>{snapshot.title}</Bidi> : null}
                <blockquote className="adm-quote">
                  <p>
                    <Bidi>{snapshot.body}</Bidi>
                  </p>
                </blockquote>
              </dd>
            </div>
            <div>
              <dt>{t('admin.disputes.snapshot.rating')}</dt>
              <dd>{f.number(snapshot.overall_rating)}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/** The other party of the target (null: the target has none). */
export function Respondent({ detail }: { detail: StaffDisputeDetail }) {
  const t = useT();
  const r = detail.respondent;
  return (
    <p data-testid="dispute-respondent">
      {r
        ? t(r.contacted ? 'admin.disputes.respondent.contacted' : 'admin.disputes.respondent.notYet', { name: r.display })
        : t('admin.disputes.respondent.none')}
    </p>
  );
}

function Message({ m }: { m: StaffDisputeMessage }) {
  const t = useT();
  const f = useFormat();
  return (
    <li className="adm-thread-item" data-author={m.author} data-testid="dispute-message">
      <p className="adm-muted">
        <strong>
          <Bidi>{m.author_display}</Bidi>
        </strong>
        {m.author === 'staff' && m.staff_author_display ? (
          <span className="adm-muted"> {t('admin.disputes.thread.writtenBy', { name: m.staff_author_display })}</span>
        ) : null}{' '}
        <time dateTime={m.created_at}>{f.date(m.created_at, 'dateTime')}</time>
        {m.template_key ? (
          <>
            {' '}
            <Badge>{enumLabel(MESSAGE_TEMPLATES, 'admin.disputes.thread.template', m.template_key, t)}</Badge>
          </>
        ) : null}
      </p>
      <p>
        <Bidi>{m.body}</Bidi>
      </p>
      {m.reply_due_at ? (
        <p className="adm-muted">{t('admin.disputes.thread.replyBy', { when: f.date(m.reply_due_at, 'dateShort') })}</p>
      ) : null}
      {m.media.length ? (
        <ul className="adm-inline-list" aria-label={t('admin.disputes.thread.files')}>
          {m.media.map((a, i) =>
            a.url ? (
              <li key={a.attachment_id}>
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {t('admin.disputes.thread.file', { n: i + 1 })}
                  <span className="sr-only"> {t('admin.disputes.thread.newTab')}</span>
                </a>
              </li>
            ) : (
              <li key={a.attachment_id}>{t('admin.disputes.thread.fileNotReady', { n: i + 1 })}</li>
            ),
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** Both threads; a composer per side while the dispute is open. */
export function DisputeThreads({
  detail,
  purpose,
  open,
}: {
  detail: StaffDisputeDetail;
  purpose: AccessPurpose;
  /** The dispute takes messages (open or in mediation). */
  open: boolean;
}) {
  const t = useT();
  const list = useApiQuery('admin.dispute_messages_list', { path: { dispute_id: detail.id }, purpose }, { refetchInterval: 60_000 });
  const items = list.data?.items ?? [];
  return (
    <section className="adm-stack" data-testid="dispute-threads" aria-labelledby="dispute-threads-t">
      <h3 id="dispute-threads-t" className="adm-subtitle">
        {t('admin.disputes.thread.title')}
      </h3>
      <p className="adm-muted">{t('admin.disputes.thread.intro')}</p>
      {list.isError ? <p className="adm-muted">{t('admin.disputes.thread.failed')}</p> : null}
      {DISPUTE_SIDES.map((side) => {
        const thread = items.filter((m) => m.side === side);
        const party = side === 'raiser' ? detail.raised_by_display : (detail.respondent?.display ?? null);
        return (
          <section key={side} className="adm-panel adm-stack" data-testid={`thread-${side}`} aria-labelledby={`thread-${side}-t`}>
            <h4 id={`thread-${side}-t`} className="adm-subtitle">
              {party ? t(`admin.disputes.thread.with.${side}`, { name: party }) : t('admin.disputes.thread.noRespondent')}
            </h4>
            {list.isPending ? (
              <p className="adm-muted">{t('admin.kit.table.loading')}</p>
            ) : thread.length ? (
              <ol className="adm-thread">
                {thread.map((m) => (
                  <Message key={m.id} m={m} />
                ))}
              </ol>
            ) : (
              <p className="adm-muted">{t('admin.disputes.thread.empty')}</p>
            )}
            {open && party ? <Composer disputeId={detail.id} side={side} purpose={purpose} /> : null}
          </section>
        );
      })}
    </section>
  );
}

function Composer({ disputeId, side, purpose }: { disputeId: string; side: DisputeSide; purpose: AccessPurpose }) {
  const t = useT();
  const uid = useId();
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState<DisputeMessageTemplate>('request_information');
  const [body, setBody] = useState('');
  const [due, setDue] = useState('');
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.dispute_message_post', {
    target: disputeId,
    onOutcome: (o) => {
      if (o.kind !== 'applied') return;
      setBody('');
      setDue('');
      setTried(false);
      void queryClient.invalidateQueries({ queryKey: ['admin.dispute_messages_list'] });
      void queryClient.invalidateQueries({ queryKey: ['admin.dispute_get'] });
    },
  });
  const problem = messageProblem(body);
  const dueIso = due ? replyDueIso(due) : null;
  const dueBad = !!due && !dueIso;
  return (
    <form
      className="adm-form"
      noValidate
      data-testid={`composer-${side}`}
      aria-labelledby={`${uid}-t`}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem || dueBad) return;
        action.reset();
        setDialog(true);
      }}
    >
      <p id={`${uid}-t`} className="adm-muted">
        {t(`admin.disputes.thread.writeTo.${side}`)}
      </p>
      <div className="cp-field">
        <label className="cp-field-label" htmlFor={`${uid}-tpl`}>
          {t('admin.disputes.thread.templateLabel')}
        </label>
        <div className="cp-field-box">
          <select
            id={`${uid}-tpl`}
            className="cp-field-input adm-select"
            value={template}
            onChange={(e) => {
              const next = e.target.value as DisputeMessageTemplate;
              setTemplate(next);
              if (!body.trim() && next !== 'other') setBody(t(`admin.disputes.thread.text.${next}`));
            }}
          >
            {MESSAGE_TEMPLATES.map((x) => (
              <option key={x} value={x}>
                {t(`admin.disputes.thread.template.${x}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <TextField
        multiline
        rows={3}
        label={t('admin.disputes.thread.message')}
        hint={t('admin.disputes.thread.messageHint')}
        error={tried && problem ? t(`admin.disputes.thread.problem.${problem}`, { n: MESSAGE_MAX }) : undefined}
        value={body}
        maxLength={MESSAGE_MAX}
        onChange={(e) => setBody(e.target.value)}
      />
      <TextField
        type="date"
        label={t('admin.disputes.thread.due')}
        hint={t('admin.disputes.thread.dueHint', { n: REPLY_DUE_MAX_DAYS })}
        error={tried && dueBad ? t('admin.disputes.thread.dueInvalid', { n: REPLY_DUE_MAX_DAYS }) : undefined}
        value={due}
        onChange={(e) => setDue(e.target.value)}
      />
      <div className="adm-actions">
        <Button type="submit" variant="secondary" icon="send" loading={action.state.status === 'busy'}>
          {t('admin.disputes.thread.send')}
        </Button>
      </div>
      <ActionNotice state={action.state} applied={t('admin.disputes.thread.sent')} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="dispute_message"
        title={t(`admin.disputes.thread.dialog.${side}`)}
        confirmLabel={t('admin.disputes.thread.send')}
        summary={<p className="adm-muted">{t('admin.disputes.thread.asCarPal')}</p>}
        onSubmit={(reason) => {
          setDialog(false);
          void action.run({
            path: { dispute_id: disputeId },
            purpose,
            body: { side, template_key: template, body: body.trim(), ...(dueIso ? { reply_due_at: dueIso } : {}), reason },
            reason,
          });
        }}
        name={`dispute-message-${side}`}
      />
    </form>
  );
}
