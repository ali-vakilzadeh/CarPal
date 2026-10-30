'use client';
// W-RPT-01 Report content (mirrors S-SHARED-08; P8.T6): one modal with a URL (?modal=report&rt=<target type>&rid=<id>)
// for anything a visitor can report — questions, answers, comments, showcases, businesses, parts. Reasons come from
// the ModerationReason enum, chosen per target; details are optional. Guests see the reasons and the form but sign in
// to send: the report (reason + details) is kept in the auth intent and sent once after sign-in (GD-06). reports.create
// is implemented (backend S8): 409 DUPLICATE → "You already reported this"; a failure keeps the form and says so —
// never a silent drop. <ReportHost> is mounted once by the shell frame; <ReportButton> opens it.
import type { ModerationReason, ReportTargetType } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { ApiProblem } from '@/lib/api';
import { useApiClient } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useGatedAction, useIntentHandler } from './auth-intent';
import { useToast } from './toast';
import { UrlModal, useUrlModal } from './url-modal';

export const REPORT_MODAL = 'report';
const PARAMS = ['rt', 'rid'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPORT_DETAILS_MAX = 2000;

const TARGETS: readonly ReportTargetType[] = [
  'review',
  'review_response',
  'post',
  'comment',
  'question',
  'answer',
  'portfolio_item',
  'media_asset',
  'inventory_item',
  'inventory_fitment',
  'organization',
  'organization_location',
  'user',
  'ai_output',
];

const CONTENT: ModerationReason[] = [
  'spam',
  'abusive',
  'harassment',
  'hate_speech',
  'unsafe_advice',
  'misleading',
  'privacy',
  'off_topic',
  'other',
];

/** The reasons offered for a target (S-SHARED-08 list, from the ModerationReason enum). */
export function reportReasons(target: ReportTargetType): ModerationReason[] {
  switch (target) {
    case 'organization':
    case 'organization_location':
      return ['fake', 'wrong_location_or_closed', 'impersonation', 'misleading', 'spam', 'abusive', 'other'];
    case 'portfolio_item':
    case 'media_asset':
      return ['non_consensual_media', 'privacy', 'consent_issue', 'redaction_issue', 'fake', 'misleading', 'abusive', 'spam', 'other'];
    case 'inventory_item':
    case 'inventory_fitment':
      return ['inaccurate_fitment', 'counterfeit', 'misleading', 'spam', 'other'];
    case 'review':
    case 'review_response':
      return ['fake', 'abusive', 'harassment', 'privacy', 'misleading', 'spam', 'other'];
    case 'user':
      return ['impersonation', 'harassment', 'spam', 'abusive', 'other'];
    case 'ai_output':
      return ['hallucination', 'unsafe_advice', 'misleading', 'other'];
    default:
      return CONTENT;
  }
}

export function parseReportTarget(params: URLSearchParams): { type: ReportTargetType; id: string } | null {
  const type = params.get('rt') as ReportTargetType | null;
  const id = params.get('rid');
  return type && TARGETS.includes(type) && id && UUID.test(id) ? { type, id } : null;
}

const REASON_TEXT = (r: ModerationReason) => `shell.report.reason.${r}` as MessageKey;

interface ReportDraft {
  reason: ModerationReason;
  details?: string;
}

interface ReportForm {
  key: string;
  reason: ModerationReason | null;
  details: string;
  error: string | null;
}

/** Opens the report modal for a target. */
export function ReportButton({
  targetType,
  targetId,
  label,
  variant = 'ghost',
}: {
  targetType: ReportTargetType;
  targetId: string;
  label?: string;
  variant?: 'ghost' | 'secondary';
}) {
  const t = useT();
  const modal = useUrlModal(REPORT_MODAL, PARAMS);
  return (
    <Button size="sm" variant={variant} icon="flag" onClick={() => modal.open({ rt: targetType, rid: targetId })}>
      {label ?? t('shell.report.open')}
    </Button>
  );
}

export function ReportHost() {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const gate = useGatedAction();
  const modal = useUrlModal(REPORT_MODAL, PARAMS);
  const target = modal.isOpen ? parseReportTarget(modal.params) : null;
  const [busy, setBusy] = useState(false);
  const targetKey = target ? `${target.type}:${target.id}` : '';
  // The form belongs to one target: opening the modal for another starts empty.
  const [form, setForm] = useState<ReportForm>({ key: '', reason: null, details: '', error: null });
  const current: ReportForm = form.key === targetKey ? form : { key: targetKey, reason: null, details: '', error: null };
  const { reason, details, error } = current;
  const update = (patch: Partial<ReportForm>) => setForm({ ...current, ...patch });

  /** Sends a report; returns the toast text. Throws for failures the form should show. */
  const send = async (type: ReportTargetType, id: string, draft: ReportDraft): Promise<string> => {
    try {
      await api.api('reports.create', {
        body: {
          target_type: type,
          target_id: id,
          reason: draft.reason,
          ...(draft.details?.trim() ? { details: draft.details.trim() } : {}),
        },
      });
      return t('shell.report.sent');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'DUPLICATE') return t('shell.report.duplicate');
      throw err;
    }
  };

  useIntentHandler<ReportDraft>('report', async (intent) => {
    const [type, id] = (intent.target ?? '').split(':');
    const draft = intent.draft;
    if (!type || !id || !draft?.reason || !TARGETS.includes(type as ReportTargetType)) return;
    try {
      return await send(type as ReportTargetType, id, draft);
    } catch {
      return t('shell.report.failed');
    }
  });

  if (modal.isOpen && !target) return null;

  const submit = () => {
    if (!target || !reason) return;
    const draft: ReportDraft = { reason, ...(details.trim() ? { details: details.trim() } : {}) };
    gate({
      type: 'report',
      target: `${target.type}:${target.id}`,
      draft,
      title: t('shell.report.intent'),
      run: async () => {
        setBusy(true);
        update({ error: null });
        try {
          toast(await send(target.type, target.id, draft));
          modal.close();
        } catch (err) {
          update({ error: err instanceof ApiProblem && err.status === 429 ? t('shell.report.slowDown') : t('shell.report.failed') });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <UrlModal
      control={modal}
      name="report"
      title={t('shell.report.title')}
      footer={
        <>
          <Button variant="primary" loading={busy} disabled={!reason} onClick={submit}>
            {t('shell.report.send')}
          </Button>
          <Button onClick={modal.close}>{t('common.actions.cancel')}</Button>
        </>
      }
    >
      {target ? (
        <form
          className="pwa-stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset className="pwa-report-reasons">
            <legend className="pwa-text-label">{t('shell.report.why')}</legend>
            {reportReasons(target.type).map((r) => (
              <label key={r} className="pwa-radio">
                <input type="radio" name="report-reason" value={r} checked={reason === r} onChange={() => update({ reason: r })} />
                <span>{t(REASON_TEXT(r))}</span>
              </label>
            ))}
          </fieldset>
          <TextField
            multiline
            rows={3}
            label={t('shell.report.details')}
            hint={t('shell.report.detailsHint')}
            value={details}
            maxLength={REPORT_DETAILS_MAX}
            onChange={(e) => update({ details: e.target.value })}
          />
          <p className="pwa-text-caption">{t('shell.report.privacy')}</p>
          {error ? <Banner tone="danger" icon="alert" text={error} /> : null}
        </form>
      ) : null}
    </UrlModal>
  );
}
