'use client';
// ReasonPanel, ReasonDialog and ConfirmDialog (AC5.T2, Docs/23 §1 principles 1 and 7, §3.3, GD-11). Every mutating
// action opens a reason: a code from the console's list for that kind of action (src/lib/config/reasons) and a note,
// required for removals, suspensions, rejections and "Other". Irreversible actions ask for a second confirmation (a
// check box the staff member must tick). A notify toggle is shown only where the operation has one (none in contract
// 1.3.0; no dead controls, GD-08).
import { useId, useState, type ReactNode } from 'react';
import { Button, type ButtonVariant } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import {
  checkReason,
  composeReason,
  EMPTY_REASON,
  noteLimit,
  noteRequired,
  REASON_SETS,
  type ReasonDraft,
  type ReasonKind,
} from '@/lib/config/reasons';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

export interface ReasonPanelProps {
  kind: ReasonKind;
  value: ReasonDraft;
  onChange: (next: ReasonDraft) => void;
  /** Show problems (after the first attempt to confirm). */
  showErrors?: boolean;
  /** Only for operations that have a notify flag in the contract. */
  notify?: { value: boolean; onChange: (v: boolean) => void };
  disabled?: boolean;
}

export function ReasonPanel({ kind, value, onChange, showErrors = false, notify, disabled }: ReasonPanelProps) {
  const t = useT();
  const id = useId();
  const problem = checkReason(kind, value);
  const required = noteRequired(kind, value.code);
  const limit = noteLimit(value.code);
  const codeError = showErrors && problem.code ? t('admin.kit.reason.codeRequired') : null;
  const noteError =
    showErrors && problem.note === 'required'
      ? t('admin.kit.reason.noteRequired')
      : problem.note === 'too_long'
        ? t('admin.kit.reason.noteTooLong', { n: limit })
        : null;
  return (
    <div className="adm-reason" data-kit="reason-panel">
      <div className={codeError ? 'cp-field is-error' : 'cp-field'}>
        <label className="cp-field-label" htmlFor={`${id}-code`}>
          {t('admin.kit.reason.code')}
        </label>
        <div className="cp-field-box">
          <select
            id={`${id}-code`}
            className="cp-field-input adm-select"
            value={value.code}
            required
            disabled={disabled}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? `${id}-code-e` : undefined}
            onChange={(e) => onChange({ ...value, code: e.target.value })}
          >
            <option value="">{t('admin.kit.reason.choose')}</option>
            {REASON_SETS[kind].codes.map((code) => (
              <option key={code} value={code}>
                {t(`admin.reasons.codes.${code}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>
        {codeError ? (
          <p id={`${id}-code-e`} className="cp-field-hint">
            {codeError}
          </p>
        ) : null}
      </div>
      <TextField
        multiline
        rows={3}
        label={required ? t('admin.kit.reason.noteRequiredLabel') : t('admin.kit.reason.note')}
        hint={t('admin.kit.reason.noteHint', { n: limit })}
        error={noteError ?? undefined}
        value={value.note}
        required={required}
        disabled={disabled}
        maxLength={limit}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
      />
      {notify ? (
        <Check checked={notify.value} onChange={(e) => notify.onChange(e.target.checked)} disabled={disabled}>
          {t('admin.kit.reason.notify')}
        </Check>
      ) : null}
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: ButtonVariant;
  /** Irreversible: a second confirmation (tick box) before Confirm works (Docs/23 §1 principle 7). */
  irreversible?: boolean;
  /** Extra condition for Confirm (e.g. a ready reason); problems show after the first click. */
  ready?: boolean;
  busy?: boolean;
  /** An error from the last attempt, shown in the dialog. */
  error?: ReactNode;
  onConfirm: () => void;
  onAttempt?: () => void;
  name?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  confirmVariant = 'primary',
  irreversible = false,
  ready = true,
  busy = false,
  error,
  onConfirm,
  onAttempt,
  name,
}: ConfirmDialogProps) {
  const t = useT();
  const [understood, setUnderstood] = useState(false);
  const [tried, setTried] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setUnderstood(false);
      setTried(false);
    }
  }
  const confirm = () => {
    setTried(true);
    onAttempt?.();
    if (!ready || (irreversible && !understood)) return;
    onConfirm();
  };
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      name={name ?? 'confirm'}
      footer={
        <>
          <Button variant={confirmVariant} loading={busy} onClick={confirm}>
            {confirmLabel}
          </Button>
          <Button disabled={busy} onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </>
      }
    >
      <div className="adm-confirm">
        {children}
        {irreversible ? (
          <div className="adm-confirm-second">
            <p>{t('admin.kit.confirm.irreversible')}</p>
            <Check checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={busy}>
              {t('admin.kit.confirm.understood')}
            </Check>
            {tried && !understood ? (
              <p className="adm-error" role="alert">
                {t('admin.kit.confirm.tickFirst')}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="adm-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export interface ReasonDialogProps extends Omit<ConfirmDialogProps, 'ready' | 'onConfirm' | 'onAttempt' | 'children'> {
  kind: ReasonKind;
  /** What the action does, shown above the reason. */
  summary?: ReactNode;
  /** Gets the reason as sent ("<code>: <note>") and the draft (for a replay after the step-up). */
  onSubmit: (reason: string, draft: ReasonDraft) => void;
  initial?: ReasonDraft;
}

/** The standard dialog of a mutating action: summary, reason panel, optional second confirmation. */
export function ReasonDialog({ kind, summary, onSubmit, initial, open, ...rest }: ReasonDialogProps) {
  const [draft, setDraft] = useState<ReasonDraft>(initial ?? EMPTY_REASON);
  const [tried, setTried] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(initial ?? EMPTY_REASON);
      setTried(false);
    }
  }
  const problem = checkReason(kind, draft);
  const ready = !problem.code && !problem.note;
  return (
    <ConfirmDialog
      {...rest}
      open={open}
      ready={ready}
      onAttempt={() => setTried(true)}
      onConfirm={() => onSubmit(composeReason(draft), draft)}
      name={rest.name ?? 'reason'}
    >
      {summary ? <div className="adm-confirm-summary">{summary}</div> : null}
      <ReasonPanel kind={kind} value={draft} onChange={setDraft} showErrors={tried} disabled={rest.busy ?? false} />
    </ConfirmDialog>
  );
}
