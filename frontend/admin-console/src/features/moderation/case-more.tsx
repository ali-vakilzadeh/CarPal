'use client';
// AC14-2 additions to the moderation case (backend S18-S22, BR-08/BR-15/BR-27/BR-28/BR-29): the author of the target
// with their history (typed snapshots, S18), the content around a comment, answer, post or question
// (admin.case_context), and the actions with their own parameters through admin.case_action: Reduce weight and Ask
// the author to edit (published reviews; reduce_weight asks for the security key), Lower the fitment confidence (a
// fitment row), Merge into another organization (organization cases; security key) and Black out parts of an image
// (apply_redaction: boxes drawn on the image, or typed in percent for the keyboard; the file leaves public serving at
// once and the media worker writes the redacted copy).
import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ModerationActionInput } from '@carpal/api-contracts';
import { ActionNotice, EntityChip, ReasonDialog, useAdminAction } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import type { AccessPurpose } from '@/lib/api/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { ReasonKind } from '@/lib/config/reasons';
import {
  cleanBox,
  EDIT_MESSAGE_MAX,
  editSpanOf,
  enumLabel,
  field,
  fitmentChoices,
  isId,
  MORE_STEP_UP,
  moreActions,
  percentOf,
  regionOf,
  str,
  WEIGHT_FACTORS,
  type MoreAction,
  type RedactionBox,
  type Target,
} from './case-logic';
import { problemText } from '@/components/admin';

const CONTEXT_TYPES = new Set(['comment', 'answer', 'post', 'question']);
const ITEM_STATUSES = ['active', 'hidden', 'removed', 'published', 'open', 'answered', 'closed', 'draft'] as const;
const AUTHOR_ROLES = ['member', 'provider', 'vendor', 'fleet', 'hybrid_provider_vendor'] as const;

const MORE_REASON: Record<MoreAction, ReasonKind> = {
  reduce_weight: 'weight_reduce',
  edit_request: 'changes_request',
  downgrade_fitment: 'fitment_downgrade',
  merge_duplicate: 'org_merge',
  apply_redaction: 'redaction',
};

interface Author {
  user_id: string;
  display_name: string;
  role: string;
  organization: { id: string; name: string } | null;
  history: { published: number; removed: number; warnings: number } | null;
}

function authorOf(t: Target): Author | null {
  const a = t.data.author as Author | null | undefined;
  return a && typeof a === 'object' && typeof a.display_name === 'string' ? a : null;
}

/** The author of the target and their history (no contact data; a neutral name once the account is gone). */
export function AuthorBlock({ target }: { target: Target }) {
  const t = useT();
  const f = useFormat();
  const a = authorOf(target);
  if (!a) return null;
  return (
    <section className="adm-panel" data-testid="case-author" aria-labelledby="case-author-t">
      <h3 id="case-author-t" className="adm-subtitle">
        {t('admin.moderation.author.title')}
      </h3>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.moderation.author.name')}</dt>
          <dd>
            <Bidi>{a.display_name}</Bidi> <EntityChip type="user" id={a.user_id} />
          </dd>
        </div>
        <div>
          <dt>{t('admin.moderation.author.as')}</dt>
          <dd>
            {enumLabel(AUTHOR_ROLES, 'admin.moderation.author.role', a.role, t)}
            {a.organization ? (
              <>
                {' · '}
                <EntityChip type="organization" id={a.organization.id} label={a.organization.name} />
              </>
            ) : null}
          </dd>
        </div>
        {a.history ? (
          <div>
            <dt>{t('admin.moderation.author.history')}</dt>
            <dd data-testid="author-history">
              {t('admin.moderation.author.historyLine', {
                published: f.number(a.history.published),
                removed: f.number(a.history.removed),
                warnings: f.number(a.history.warnings),
              })}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

/** The content around a comment, answer, post or question (admin.case_context, under the case purpose). */
export function CaseContextPanel({ caseId, target, purpose }: { caseId: string; target: Target; purpose: AccessPurpose }) {
  const t = useT();
  const enabled = CONTEXT_TYPES.has(target.type);
  const q = useApiQuery('admin.case_context', enabled ? { path: { case_id: caseId }, purpose } : undefined, { enabled, retry: false });
  if (!enabled) return null;
  const parent = q.data?.parent as Record<string, unknown> | null | undefined;
  return (
    <section className="adm-panel adm-stack" data-testid="case-context" aria-labelledby="case-context-t">
      <h3 id="case-context-t" className="adm-subtitle">
        {t('admin.moderation.context.title')}
      </h3>
      {q.isPending ? <p className="adm-muted">{t('admin.kit.table.loading')}</p> : null}
      {q.isError ? <p className="adm-muted">{t('admin.moderation.context.failed')}</p> : null}
      {parent && parent.available !== false ? (
        <div data-testid="context-parent">
          <p className="adm-muted">{t('admin.moderation.context.parent')}</p>
          <blockquote className="adm-quote">
            {str(parent.title) ? (
              <p>
                <strong>
                  <Bidi>{str(parent.title)}</Bidi>
                </strong>
              </p>
            ) : null}
            <p>
              <Bidi>{str(parent.body) ?? '—'}</Bidi>
            </p>
          </blockquote>
        </div>
      ) : null}
      {q.data ? (
        q.data.items.length ? (
          <>
            <p className="adm-muted">{t('admin.moderation.context.around', { shown: q.data.items.length, total: q.data.total })}</p>
            <ol className="adm-thread">
              {q.data.items.map((i) => {
                const it = i as unknown as Record<string, unknown> & { id: string; author?: Author | null };
                const mine = it.id === target.id;
                return (
                  <li key={it.id} className="adm-thread-item" data-current={mine || undefined} data-testid="context-item">
                    <p className="adm-muted">
                      <Bidi>{it.author?.display_name ?? '—'}</Bidi>
                      {' · '}
                      {enumLabel(ITEM_STATUSES, 'admin.moderation.status', str(it.status), t)}
                      {mine ? (
                        <>
                          {' '}
                          <Badge tone="signal">{t('admin.moderation.context.reported')}</Badge>
                        </>
                      ) : null}
                    </p>
                    <p className="adm-thread-body">
                      <Bidi>{str(it.body) ?? str(it.title) ?? '—'}</Bidi>
                    </p>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p className="adm-muted">{t('admin.moderation.context.none')}</p>
        )
      ) : null}
    </section>
  );
}

/** The actions with their own parameters that apply to the target. */
export function MoreActions({
  target,
  caseId,
  purpose,
  onDone,
}: {
  target: Target;
  caseId: string;
  purpose: AccessPurpose;
  onDone: () => void;
}) {
  const list = moreActions(target);
  if (!list.length) return null;
  return (
    <>
      {list.map((a) => (
        <MoreActionPanel key={a} action={a} target={target} caseId={caseId} purpose={purpose} onDone={onDone} />
      ))}
    </>
  );
}

function MoreActionPanel({
  action,
  target,
  caseId,
  purpose,
  onDone,
}: {
  action: MoreAction;
  target: Target;
  caseId: string;
  purpose: AccessPurpose;
  onDone: () => void;
}) {
  const t = useT();
  const uid = useId();
  const [weight, setWeight] = useState<string>('0.5');
  const [field_, setField] = useState<'title' | 'body'>('body');
  const [passage, setPassage] = useState('');
  const [message, setMessage] = useState('');
  const fitChoices = fitmentChoices(field(target, 'confidence'));
  const [confidence, setConfidence] = useState<'likely' | 'uncertain'>(fitChoices[0] ?? 'uncertain');
  const [into, setInto] = useState('');
  const [boxes, setBoxes] = useState<RedactionBox[]>([]);
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const run = useAdminAction('admin.case_action', {
    target: caseId,
    onOutcome: (o) => {
      if (o.kind === 'applied') {
        setBoxes([]);
        onDone();
      }
    },
  });

  const span = action === 'edit_request' ? editSpanOf(field(target, field_), passage) : null;
  const problem = (() => {
    if (action === 'edit_request') {
      if (!span) return 'passage';
      if (!message.trim() || message.length > EDIT_MESSAGE_MAX) return 'message';
    }
    if (action === 'merge_duplicate' && (!isId(into) || into.trim().toLowerCase() === target.id)) return 'into';
    if (action === 'apply_redaction' && !boxes.length) return 'boxes';
    return null;
  })();

  const params = (): ModerationActionInput['params'] => {
    switch (action) {
      case 'reduce_weight':
        return { weight_factor: weight };
      case 'edit_request':
        return { edit_spans: [{ field: field_, start: span!.start, end: span!.end }], edit_message: message.trim() };
      case 'downgrade_fitment':
        return { fitment_confidence: confidence };
      case 'merge_duplicate':
        return { merge_into_id: into.trim().toLowerCase() };
      case 'apply_redaction':
        return { redaction_regions: boxes.map(regionOf) };
    }
  };

  const form = (() => {
    switch (action) {
      case 'reduce_weight':
        return (
          <div className="cp-field">
            <label className="cp-field-label" htmlFor={`${uid}-w`}>
              {t('admin.moderation.more.weight')}
            </label>
            <div className="cp-field-box">
              <select id={`${uid}-w`} className="cp-field-input adm-select" value={weight} onChange={(e) => setWeight(e.target.value)}>
                {WEIGHT_FACTORS.map((w) => (
                  <option key={w} value={w}>
                    {w === '1'
                      ? t('admin.moderation.more.weightRestore')
                      : t('admin.moderation.more.weightKeep', { n: Math.round(Number(w) * 100) })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      case 'edit_request':
        return (
          <>
            <fieldset className="adm-choices adm-choices-row">
              <legend>{t('admin.moderation.more.editField')}</legend>
              {(['body', 'title'] as const).map((x) => (
                <label key={x} className="adm-radio">
                  <input
                    type="radio"
                    name={`${uid}-field`}
                    value={x}
                    checked={field_ === x}
                    disabled={x === 'title' && !field(target, 'title')}
                    onChange={() => setField(x)}
                  />
                  {t(`admin.moderation.more.editFields.${x}`)}
                </label>
              ))}
            </fieldset>
            <TextField
              multiline
              rows={2}
              label={t('admin.moderation.more.passage')}
              hint={t('admin.moderation.more.passageHint')}
              error={tried && problem === 'passage' ? t('admin.moderation.more.passageMissing') : undefined}
              value={passage}
              onChange={(e) => setPassage(e.target.value)}
            />
            <TextField
              multiline
              rows={3}
              label={t('admin.moderation.more.editMessage')}
              hint={t('admin.moderation.more.editMessageHint')}
              error={tried && problem === 'message' ? t('admin.moderation.more.editMessageMissing', { n: EDIT_MESSAGE_MAX }) : undefined}
              value={message}
              maxLength={EDIT_MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
            />
          </>
        );
      case 'downgrade_fitment':
        return (
          <fieldset className="adm-choices adm-choices-row">
            <legend>{t('admin.moderation.more.confidence')}</legend>
            {fitChoices.map((c) => (
              <label key={c} className="adm-radio">
                <input type="radio" name={`${uid}-conf`} value={c} checked={confidence === c} onChange={() => setConfidence(c)} />
                {t(`admin.moderation.more.confidences.${c}`)}
              </label>
            ))}
          </fieldset>
        );
      case 'merge_duplicate':
        return (
          <TextField
            label={t('admin.moderation.more.into')}
            hint={t('admin.moderation.more.intoHint')}
            error={tried && problem === 'into' ? t('admin.moderation.more.intoInvalid') : undefined}
            value={into}
            dir="ltr"
            maxLength={36}
            autoComplete="off"
            onChange={(e) => setInto(e.target.value)}
          />
        );
      case 'apply_redaction':
        return (
          <RedactionEditor mediaId={target.id} purpose={purpose} boxes={boxes} onChange={setBoxes} error={tried && problem === 'boxes'} />
        );
    }
  })();

  return (
    <section className="adm-panel adm-stack" data-testid={`more-${action}`} aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="adm-subtitle">
        {t(`admin.moderation.more.title.${action}`)}
      </h3>
      <p className="adm-muted">{t(`admin.moderation.more.effect.${action}`)}</p>
      {form}
      <div className="adm-actions">
        <Button
          size="sm"
          variant={action === 'merge_duplicate' || action === 'apply_redaction' ? 'danger' : 'secondary'}
          loading={run.state.status === 'busy'}
          onClick={() => {
            setTried(true);
            if (problem) return;
            run.reset();
            setDialog(true);
          }}
        >
          {t(`admin.moderation.more.do.${action}`)}
        </Button>
      </div>
      {run.state.status === 'done' || run.state.status === 'failed' ? (
        <ActionNotice state={run.state} applied={t(`admin.moderation.more.done.${action}`)} />
      ) : null}
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind={MORE_REASON[action]}
        title={t(`admin.moderation.more.title.${action}`)}
        confirmLabel={t(`admin.moderation.more.do.${action}`)}
        confirmVariant={action === 'merge_duplicate' || action === 'apply_redaction' ? 'danger' : 'primary'}
        irreversible={action === 'merge_duplicate'}
        summary={
          <>
            <p className="adm-muted">{t(`admin.moderation.more.effect.${action}`)}</p>
            {MORE_STEP_UP.has(action) ? <p className="adm-muted">{t('admin.moderation.stepUp')}</p> : null}
          </>
        }
        onSubmit={(reason) => {
          setDialog(false);
          void run.run({ path: { case_id: caseId }, purpose, body: { action_type: action, reason, params: params() }, reason });
        }}
        name={`case-${action}`}
      />
    </section>
  );
}

/**
 * Boxes to black out on an image: drawn with the pointer over the image (a purpose-bound 5-minute display link) or typed
 * in percent of the image for the keyboard; each box can be removed. Kept as fractions of the image (0-1).
 */
function RedactionEditor({
  mediaId,
  purpose,
  boxes,
  onChange,
  error,
}: {
  mediaId: string;
  purpose: AccessPurpose;
  boxes: RedactionBox[];
  onChange: (b: RedactionBox[]) => void;
  error: boolean;
}) {
  const t = useT();
  const uid = useId();
  const api = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState<RedactionBox | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState({ x: '', y: '', w: '', h: '' });
  const load = async () => {
    setBusy(true);
    try {
      const r = await api.api('admin.media_download_url', { path: { media_id: mediaId }, body: { variant: 'display' }, purpose });
      setUrl(r.url);
    } catch (err) {
      setProblem(err as ApiProblem);
    } finally {
      setBusy(false);
    }
  };
  const at = (e: ReactPointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / (r.width || 1), y: (e.clientY - r.top) / (r.height || 1) };
  };
  const add = (b: RedactionBox | null) => {
    const c = b ? cleanBox(b) : null;
    if (c) onChange([...boxes, c].slice(0, 20));
  };
  const typedBox = (() => {
    const x = percentOf(typed.x);
    const y = percentOf(typed.y);
    const w = percentOf(typed.w);
    const h = percentOf(typed.h);
    return x == null || y == null || w == null || h == null ? null : cleanBox({ x, y, w, h });
  })();
  return (
    <div className="adm-stack" data-testid="redaction-editor">
      {url ? (
        <div
          ref={frame}
          className="adm-redact-frame"
          data-testid="redaction-frame"
          onPointerDown={(e) => {
            const p = at(e);
            setDrawing({ x: p.x, y: p.y, w: 0, h: 0 });
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drawing) return;
            const p = at(e);
            setDrawing({ ...drawing, w: p.x - drawing.x, h: p.y - drawing.y });
          }}
          onPointerUp={() => {
            add(drawing);
            setDrawing(null);
          }}
        >
          {/* A signed display copy from the storage host (CSP img-src), as in MediaViewer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={t('admin.moderation.media.alt')} draggable={false} referrerPolicy="no-referrer" />
          {[...boxes, ...(drawing ? [drawing] : [])].map((b, i) => {
            const c = cleanBox(b) ?? b;
            return (
              <span
                key={i}
                className="adm-redact-box"
                aria-hidden="true"
                style={{
                  insetInlineStart: `${c.x * 100}%`,
                  insetBlockStart: `${c.y * 100}%`,
                  inlineSize: `${Math.abs(c.w) * 100}%`,
                  blockSize: `${Math.abs(c.h) * 100}%`,
                }}
              />
            );
          })}
        </div>
      ) : (
        <div>
          <Button size="sm" variant="secondary" icon="image" loading={busy} onClick={() => void load()}>
            {t('admin.moderation.more.redactShow')}
          </Button>
          {problem ? (
            <p className="adm-error" role="alert">
              {problemText(problem, t)}
            </p>
          ) : null}
        </div>
      )}
      <p className="adm-muted">{t('admin.moderation.more.redactHint')}</p>
      <fieldset className="adm-redact-typed">
        <legend>{t('admin.moderation.more.redactTyped')}</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <TextField
            key={k}
            label={t(`admin.moderation.more.redactField.${k}`)}
            value={typed[k]}
            inputMode="decimal"
            dir="ltr"
            maxLength={6}
            onChange={(e) => setTyped((v) => ({ ...v, [k]: e.target.value }))}
          />
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={!typedBox}
          onClick={() => {
            add(typedBox);
            setTyped({ x: '', y: '', w: '', h: '' });
          }}
        >
          {t('admin.moderation.more.redactAdd')}
        </Button>
      </fieldset>
      {boxes.length ? (
        <ul className="adm-stack" aria-label={t('admin.moderation.more.redactBoxes')} id={`${uid}-boxes`}>
          {boxes.map((b, i) => (
            <li key={i} data-testid="redaction-box">
              {t('admin.moderation.more.redactBox', {
                n: i + 1,
                x: Math.round(b.x * 100),
                y: Math.round(b.y * 100),
                w: Math.round(b.w * 100),
                h: Math.round(b.h * 100),
              })}{' '}
              <Button size="sm" variant="ghost" onClick={() => onChange(boxes.filter((_, j) => j !== i))}>
                {t('admin.moderation.more.redactRemove', { n: i + 1 })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="cp-field-error" role="alert">
          {t('admin.moderation.more.redactNone')}
        </p>
      ) : null}
    </div>
  );
}
