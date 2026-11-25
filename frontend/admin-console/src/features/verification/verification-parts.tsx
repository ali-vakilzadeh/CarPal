'use client';
// AC14-2 parts of the verification review (backend S19, BR-34; Docs/23 A-VER-01/02): who the check is assigned to and
// Take / Assign to a colleague (admin.verification_assign; only the assignee works on it under its purpose), the
// request for more information as the business reads it (missing items, message, its answer), and the form that asks
// for it (admin.verification_decide info_requested: the check stays pending, its clock pauses until the business
// answers, it is assigned to the caller when unassigned and the business is notified).
import { useId, useState } from 'react';
import type { VerificationInfoRequest } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { enumLabel } from '@/features/moderation';
import {
  INFO_MESSAGE_MAX,
  INFO_TEMPLATES,
  infoRequestProblem,
  itemsOfTemplate,
  MISSING_ITEMS,
  VERIFICATION_COLLEAGUE_REASON,
  VERIFICATION_TAKE_REASON,
  type InfoTemplate,
  type MissingItem,
  type QueueItem,
} from './verification-logic';

/** Who the check is with, and Take / Assign to a colleague (moderators and administrators). */
export function VerificationAssign({ item, onAssigned }: { item: QueueItem; onAssigned: () => void }) {
  const t = useT();
  const uid = useId();
  const session = useSession();
  const myId = session.data?.staff?.id;
  const [to, setTo] = useState('');
  const staff = useApiQuery('admin.staff_list', { query: { status: 'active', limit: 100 } }, { staleTime: 5 * 60_000 });
  const colleagues = (staff.data?.items ?? []).filter(
    (s) =>
      s.user_id !== myId &&
      s.user_id !== item.assignee?.user_id &&
      s.platform_roles.some((r) => r === 'platform_moderator' || r === 'platform_admin'),
  );
  const assign = useAdminAction('admin.verification_assign', {
    target: item.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') onAssigned();
    },
  });
  const busy = assign.state.status === 'busy';
  const mine = !!item.assignee && item.assignee.user_id === myId;
  const take = () => {
    assign.reset();
    void assign.run({ path: { verification_id: item.id }, body: { reason: VERIFICATION_TAKE_REASON }, reason: VERIFICATION_TAKE_REASON });
  };
  const give = () => {
    const c = colleagues.find((s) => s.user_id === to);
    if (!c) return;
    assign.reset();
    const reason = `${VERIFICATION_COLLEAGUE_REASON}: ${c.display_name}`;
    void assign.run({ path: { verification_id: item.id }, body: { assignee_user_id: c.user_id, reason }, reason });
  };
  return (
    <div className="adm-stack" data-testid="verification-assign">
      <p data-testid="verification-assignee">
        {mine
          ? t('admin.verification.assign.yours')
          : item.assignee
            ? t('admin.verification.assign.with', { name: item.assignee.display_name })
            : t('admin.verification.assign.nobody')}
      </p>
      {!mine ? (
        <div className="adm-actions">
          <Button size="sm" variant="secondary" icon="user" disabled={busy} loading={busy} onClick={take}>
            {item.assignee ? t('admin.verification.assign.takeOver') : t('admin.verification.assign.take')}
          </Button>
        </div>
      ) : null}
      {colleagues.length ? (
        <div className="adm-actions">
          <div className="cp-field">
            <label className="cp-field-label" htmlFor={`${uid}-to`}>
              {t('admin.verification.assign.to')}
            </label>
            <div className="cp-field-box">
              <select id={`${uid}-to`} className="cp-field-input adm-select" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t('admin.verification.assign.choose')}</option>
                {colleagues.map((s) => (
                  <option key={s.user_id} value={s.user_id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button size="sm" variant="secondary" disabled={busy || !to} onClick={give}>
            {t('admin.verification.assign.assign')}
          </Button>
        </div>
      ) : null}
      <ActionNotice state={assign.state} applied={t('admin.verification.assign.done')} />
    </div>
  );
}

/** The latest request for more information, as the business reads it, with its answer. */
export function InfoRequestView({ request }: { request: VerificationInfoRequest }) {
  const t = useT();
  const f = useFormat();
  return (
    <section className="adm-panel adm-stack" data-testid="info-request" aria-labelledby="info-request-t">
      <h4 id="info-request-t" className="adm-subtitle">
        {t(`admin.verification.info.state.${request.status === 'open' ? 'open' : request.status === 'answered' ? 'answered' : 'closed'}`)}
      </h4>
      <p className="adm-muted">{t('admin.verification.info.askedOn', { when: f.date(request.requested_at, 'dateTime') })}</p>
      <ul className="adm-inline-list">
        {request.missing_items.map((m) => (
          <li key={m}>{enumLabel(MISSING_ITEMS, 'admin.verification.info.item', m, t)}</li>
        ))}
      </ul>
      <blockquote className="adm-quote">
        <p>
          <Bidi>{request.message}</Bidi>
        </p>
      </blockquote>
      {request.answered_at ? (
        <>
          <p>{t('admin.verification.info.answeredOn', { when: f.date(request.answered_at, 'dateTime') })}</p>
          {request.response_note ? (
            <blockquote className="adm-quote">
              <p>
                <Bidi>{request.response_note}</Bidi>
              </p>
            </blockquote>
          ) : null}
          <p className="adm-muted">{t('admin.verification.info.added', { n: f.number(request.added_document_ids.length) })}</p>
        </>
      ) : null}
    </section>
  );
}

/** Ask the business for more information (admin.verification_decide info_requested; purpose-bound, with a reason). */
export function InfoRequestForm({
  item,
  purpose,
  onSent,
  disabled,
}: {
  item: QueueItem;
  purpose: AccessPurpose;
  onSent: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<InfoTemplate>('missing_documents');
  const [items, setItems] = useState<MissingItem[]>(() => itemsOfTemplate('missing_documents', item.verification_type));
  const [message, setMessage] = useState(() => t('admin.verification.info.text.missing_documents'));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.verification_decide', {
    target: item.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') {
        setOpen(false);
        onSent();
      }
    },
  });
  const problem = infoRequestProblem(items, message);
  const pick = (next: InfoTemplate) => {
    setTemplate(next);
    setItems(itemsOfTemplate(next, item.verification_type));
    setMessage(next === 'other' ? '' : t(`admin.verification.info.text.${next}`));
  };
  if (!open)
    return (
      <div className="adm-stack">
        <div className="adm-actions">
          <Button
            variant="secondary"
            icon="send"
            disabled={disabled || action.state.status === 'busy'}
            onClick={() => {
              action.reset();
              setOpen(true);
            }}
          >
            {t('admin.verification.info.open')}
          </Button>
        </div>
        <ActionNotice state={action.state} applied={t('admin.verification.info.sent')} />
      </div>
    );
  return (
    <form
      className="adm-form adm-panel"
      noValidate
      data-testid="info-request-form"
      aria-labelledby={`${uid}-t`}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        setDialog(true);
      }}
    >
      <h3 id={`${uid}-t`} className="adm-subtitle">
        {t('admin.verification.info.title')}
      </h3>
      <p className="adm-muted">{t('admin.verification.info.effect')}</p>
      <div className="cp-field">
        <label className="cp-field-label" htmlFor={`${uid}-template`}>
          {t('admin.verification.info.template')}
        </label>
        <div className="cp-field-box">
          <select
            id={`${uid}-template`}
            className="cp-field-input adm-select"
            value={template}
            onChange={(e) => pick(e.target.value as InfoTemplate)}
          >
            {INFO_TEMPLATES.map((x) => (
              <option key={x} value={x}>
                {t(`admin.verification.info.templates.${x}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset className="adm-checklist" aria-describedby={tried && problem === 'items' ? `${uid}-items-e` : undefined}>
        <legend>{t('admin.verification.info.items')}</legend>
        {MISSING_ITEMS.map((m) => (
          <Check
            key={m}
            checked={items.includes(m)}
            onChange={(e) => setItems((xs) => (e.target.checked ? [...xs, m] : xs.filter((x) => x !== m)))}
          >
            {t(`admin.verification.info.item.${m}`)}
          </Check>
        ))}
        {tried && problem === 'items' ? (
          <p id={`${uid}-items-e`} className="cp-field-error" role="alert">
            {t('admin.verification.info.itemsRequired')}
          </p>
        ) : null}
      </fieldset>
      <TextField
        multiline
        rows={4}
        label={t('admin.verification.info.message')}
        hint={t('admin.verification.info.messageHint')}
        error={
          tried && (problem === 'message' || problem === 'too_long')
            ? t(problem === 'message' ? 'admin.verification.info.messageRequired' : 'admin.verification.info.messageTooLong')
            : undefined
        }
        value={message}
        maxLength={INFO_MESSAGE_MAX}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="adm-actions">
        <Button type="submit" variant="primary" icon="send" loading={action.state.status === 'busy'}>
          {t('admin.verification.info.send')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('admin.verification.info.cancel')}
        </Button>
      </div>
      {action.state.status === 'failed' ? <Banner tone="danger" text={t('admin.verification.info.failed')} /> : null}
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="verification_info"
        title={t('admin.verification.info.dialog')}
        confirmLabel={t('admin.verification.info.send')}
        summary={<p className="adm-muted">{t('admin.verification.info.effect')}</p>}
        onSubmit={(reason) => {
          setDialog(false);
          void action.run({
            path: { verification_id: item.id },
            purpose,
            body: {
              decision: 'info_requested',
              info_request: { missing_items: items, template_key: template, message: message.trim() },
              reason,
            },
            reason,
          });
        }}
        name="verification-info"
      />
    </form>
  );
}
