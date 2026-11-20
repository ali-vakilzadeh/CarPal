'use client';
// Policies & consent texts (AC14.T4, Docs/23 A-POL-01, Docs/40 §6.7 and §23.5, backend S15/S15b). Platform admins see
// the region's 16 documents (terms, privacy, community guidelines, then one consent text per consent type) with the
// version in force, a scheduled one and drafts. A document's versions open read for their texts in EN and FA
// (admin.policy_version_get); published, scheduled and superseded versions are read-only. "New version" starts a draft
// from the newest version's texts (admin.policy_version_create: label, title and text in every locale, an optional
// change summary); a draft is edited with If-Match (admin.policy_version_update, only the changed fields) and sent for
// publication with an effective time — as soon as a second admin approves, or from a day and time on the staff
// member's clock — and the re-consent flag; a consent text that asks for re-consent also asks whether the consents
// under the older text stay in effect (preselected) or pause until confirmed (DQ-19). Publishing waits for a second
// platform admin (4EYES). Texts are Markdown and are shown as typed (no rendering, D-99). The BFF lets the two text
// writes carry 256 KiB (S15-D2). Backend pnpm seed:consent-texts loads 13 reviewed consent texts as drafts (S26a).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import type { PolicyKey, ReconsentMode, StaffPolicyDocument, StaffPolicyVersion, StaffPolicyVersionSummary } from '@carpal/api-contracts';
import { ActionNotice, AuditDrawer, CaseLayout, DataTable, ReasonDialog, useAdminAction, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import { ifMatchOf } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { dayIn } from '@/features/plans';
import {
  draftOf,
  offersReconsentAction,
  patchOf,
  POLICY_KEYS,
  POLICY_LOCALES,
  publishOf,
  RECONSENT_ACTIONS,
  RECONSENT_MODES,
  statusTone,
  VERSION_STATUSES,
  writeOf,
  type DraftProblem,
  type PolicyLocale,
  type PublishDraft,
  type VersionDraft,
} from './policy-logic';

const LIST_KEY = ['admin.policies_list'] as const;
const NEW = 'new';

const known = <T extends string>(list: readonly T[], v: string, key: string, t: Translate) =>
  (list as readonly string[]).includes(v) ? t(`${key}.${v}` as MessageKey) : t('admin.kit.unknown', { value: v });
export const policyName = (k: string, t: Translate) => known(POLICY_KEYS, k, 'admin.policies.key', t);
export const modeLabel = (m: string, t: Translate) => known(RECONSENT_MODES, m, 'admin.policies.mode', t);
export const versionStatus = (s: string, t: Translate) => known(VERSION_STATUSES, s, 'admin.policies.status', t);
const actionLabel = (a: string, t: Translate) => known(RECONSENT_ACTIONS, a, 'admin.policies.reconsentAction', t);

const inForce = (d: StaffPolicyDocument) => d.versions.find((v) => v.status === 'published') ?? null;
const scheduled = (d: StaffPolicyDocument) => d.versions.find((v) => v.status === 'scheduled') ?? null;

export function PoliciesPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const list = useApiQuery('admin.policies_list', {});
  const docs = list.data?.items;
  const selected = docs?.find((d) => d.policy_key === params.get('policy')) ?? null;
  const go = (policy: string | null, version: string | null) => {
    const q = new URLSearchParams(params);
    if (policy) q.set('policy', policy);
    else q.delete('policy');
    if (version) q.set('version', version);
    else q.delete('version');
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const versionParam = selected ? params.get('version') : null;
  const version = selected && versionParam && versionParam !== NEW ? (selected.versions.find((v) => v.id === versionParam) ?? null) : null;

  const columns: Column<StaffPolicyDocument>[] = [
    { id: 'doc', header: t('admin.policies.col.document'), pinned: true, cell: (d) => policyName(d.policy_key, t) },
    { id: 'mode', header: t('admin.policies.col.mode'), cell: (d) => modeLabel(d.reconsent_mode, t) },
    {
      id: 'current',
      header: t('admin.policies.col.inForce'),
      cell: (d) => {
        const v = inForce(d);
        return v ? <Bidi ltr>{v.policy_version}</Bidi> : <Badge tone="danger">{t('admin.policies.none')}</Badge>;
      },
    },
    {
      id: 'next',
      header: t('admin.policies.col.next'),
      cell: (d) => {
        const s = scheduled(d);
        const drafts = d.versions.filter((v) => v.status === 'draft').length;
        const parts = [
          s ? t('admin.policies.scheduledN', { label: s.policy_version }) : null,
          drafts ? t('admin.policies.draftsN', { count: drafts }) : null,
        ];
        return parts.filter(Boolean).join(' · ') || '—';
      },
    },
  ];

  return (
    <div className="adm-page" data-testid="policies-page">
      <h1 className="adm-page-title">{t('admin.policies.title')}</h1>
      <p className="adm-measure">{t('admin.policies.intro')}</p>
      <CaseLayout
        labels={{ list: t('admin.policies.listLabel'), item: t('admin.policies.itemLabel'), decision: t('admin.policies.historyLabel') }}
        list={
          <DataTable
            id="policies"
            caption={t('admin.policies.listLabel')}
            columns={columns}
            rows={docs}
            rowKey={(d) => d.policy_key}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.policies.empty')}
            selectedKey={selected?.policy_key ?? null}
            onSelect={(d) => go(d.policy_key, null)}
          />
        }
        item={
          selected ? (
            <DocumentPanel key={selected.policy_key} doc={selected} versionId={versionParam} onOpen={(id) => go(selected.policy_key, id)} />
          ) : (
            <p className="adm-muted">{t('admin.policies.pick')}</p>
          )
        }
        decision={
          version ? (
            <>
              <h2 className="adm-panel-title">{t('admin.policies.historyLabel')}</h2>
              <AuditDrawer
                entityType="policy_version"
                entityId={version.id}
                label={`${policyName(version.policy_key, t)} ${version.policy_version}`}
              />
            </>
          ) : (
            <p className="adm-muted">{t('admin.policies.pickVersion')}</p>
          )
        }
      />
    </div>
  );
}

function DocumentPanel({ doc, versionId, onOpen }: { doc: StaffPolicyDocument; versionId: string | null; onOpen: (id: string) => void }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const newest = doc.versions[0] ?? null;
  return (
    <article data-testid="policy-document" data-policy={doc.policy_key}>
      <h2 className="adm-panel-title">{policyName(doc.policy_key, t)}</h2>
      <p className="adm-muted">{t(`admin.policies.modeText.${doc.reconsent_mode}` as MessageKey)}</p>
      <section aria-labelledby={`${uid}-v`}>
        <h3 id={`${uid}-v`} className="adm-section-title">
          {t('admin.policies.versions')}
        </h3>
        {doc.versions.length ? (
          <table className="adm-table" data-testid="policy-versions">
            <caption className="sr-only">{t('admin.policies.versions')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.policies.col.version')}</th>
                <th scope="col">{t('admin.policies.col.status')}</th>
                <th scope="col">{t('admin.policies.col.effective')}</th>
                <th scope="col">{t('admin.policies.col.reconsent')}</th>
              </tr>
            </thead>
            <tbody>
              {doc.versions.map((v) => (
                <tr key={v.id} aria-current={v.id === versionId ? 'true' : undefined}>
                  <td>
                    <button type="button" className="adm-link" onClick={() => onOpen(v.id)}>
                      <Bidi ltr>{v.policy_version}</Bidi>
                    </button>
                  </td>
                  <td>
                    <Badge tone={statusTone(v.status)}>{versionStatus(v.status, t)}</Badge>
                  </td>
                  <td>{v.effective_at ? f.date(v.effective_at, 'dateTime') : '—'}</td>
                  <td>
                    {v.requires_reconsent
                      ? v.reconsent_action
                        ? t('admin.policies.reconsentWith', { action: actionLabel(v.reconsent_action, t) })
                        : t('admin.policies.yes')
                      : t('admin.policies.no')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="adm-muted">{t('admin.policies.noVersions')}</p>
        )}
        <div className="adm-actions">
          <Button variant="secondary" onClick={() => onOpen(NEW)} disabled={versionId === NEW}>
            {t('admin.policies.newVersion')}
          </Button>
        </div>
      </section>
      {versionId === NEW ? (
        <NewVersion key={newest?.id ?? 'none'} doc={doc} from={newest} onCreated={onOpen} />
      ) : versionId ? (
        <VersionView key={versionId} doc={doc} versionId={versionId} />
      ) : null}
    </article>
  );
}

/** "New version": the newest version's texts (read with policy_version_get) as the start, with an empty label. */
function NewVersion({
  doc,
  from,
  onCreated,
}: {
  doc: StaffPolicyDocument;
  from: StaffPolicyVersionSummary | null;
  onCreated: (id: string) => void;
}) {
  const t = useT();
  const base = useApiQuery('admin.policy_version_get', { path: { version_id: from?.id ?? '' } }, { enabled: !!from });
  if (from && base.isPending) return <p className="adm-muted">{t('admin.policies.loading')}</p>;
  if (from && base.error) return <LoadFailed onRetry={() => void base.refetch()} />;
  return (
    <section data-testid="policy-new" aria-label={t('admin.policies.newTitle')}>
      <h3 className="adm-section-title">{t('admin.policies.newTitle')}</h3>
      {from ? <p className="adm-muted">{t('admin.policies.newFrom', { label: from.policy_version })}</p> : null}
      <VersionForm doc={doc} stored={null} initial={draftOf(base.data ?? null, false)} onCreated={onCreated} />
    </section>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="adm-table-error">
      <Banner tone="danger" text={t('admin.policies.loadFailed')} />
      <Button size="sm" icon="refresh" onClick={onRetry}>
        {t('admin.kit.table.retry')}
      </Button>
    </div>
  );
}

function VersionView({ doc, versionId }: { doc: StaffPolicyDocument; versionId: string }) {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery('admin.policy_version_get', { path: { version_id: versionId } });
  if (q.isPending) return <p className="adm-muted">{t('admin.policies.loading')}</p>;
  if (q.error || !q.data) return <LoadFailed onRetry={() => void q.refetch()} />;
  const v = q.data;
  return (
    <section data-testid="policy-version" data-status={v.status} aria-label={`${policyName(v.policy_key, t)} ${v.policy_version}`}>
      <h3 className="adm-section-title">
        {t('admin.policies.versionTitle', { label: v.policy_version })}{' '}
        <Badge tone={statusTone(v.status)}>{versionStatus(v.status, t)}</Badge>
      </h3>
      <dl className="adm-facts">
        <dt>{t('admin.policies.createdBy')}</dt>
        <dd>
          <Bidi>{v.created_by_display}</Bidi> · {f.date(v.created_at, 'dateTime')}
        </dd>
        {v.published_at ? (
          <>
            <dt>{t('admin.policies.publishedBy')}</dt>
            <dd>
              {v.published_by_display ? <Bidi>{v.published_by_display}</Bidi> : t('admin.policies.seeded')}
              {v.approved_by_display ? (
                <>
                  {' · '}
                  {t('admin.policies.approvedBy', { name: v.approved_by_display })}
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {v.effective_at ? (
          <>
            <dt>{t('admin.policies.col.effective')}</dt>
            <dd>{f.date(v.effective_at, 'dateTime')}</dd>
          </>
        ) : null}
      </dl>
      {v.status === 'draft' ? (
        <>
          <VersionForm doc={doc} stored={v} initial={draftOf(v)} />
          <PublishPanel doc={doc} version={v} />
        </>
      ) : (
        <>
          <p className="adm-muted" data-testid="policy-readonly">
            {t('admin.policies.readOnly')}
          </p>
          {POLICY_LOCALES.map((l) => (
            <ReadText key={l} locale={l} v={v} />
          ))}
        </>
      )}
    </section>
  );
}

function ReadText({ locale, v }: { locale: PolicyLocale; v: StaffPolicyVersion }) {
  const t = useT();
  const dir = locale === 'fa' ? 'rtl' : 'ltr';
  const summary = v.change_summary_translations?.[locale];
  return (
    <section className="adm-panel" aria-label={t(`admin.policies.locale.${locale}`)}>
      <h4 className="adm-section-title">{t(`admin.policies.locale.${locale}`)}</h4>
      <p lang={locale} dir={dir}>
        <strong>{v.title_translations[locale] ?? '—'}</strong>
      </p>
      {summary ? (
        <p lang={locale} dir={dir} className="adm-muted">
          {summary}
        </p>
      ) : null}
      <div
        lang={locale}
        dir={dir}
        className="adm-policy-text"
        tabIndex={0}
        aria-label={t('admin.policies.textOf', { locale: t(`admin.policies.locale.${locale}`) })}
      >
        {v.body_translations[locale] ?? ''}
      </div>
    </section>
  );
}

const problemKey = (p: DraftProblem): MessageKey =>
  p === 'label' ? 'admin.policies.problem.label' : (`admin.policies.problem.${p.split('.')[0]}` as MessageKey);

/** The draft form: a new version (create) or a stored draft (update with If-Match, only what changed). */
function VersionForm({
  doc,
  stored,
  initial,
  onCreated,
}: {
  doc: StaffPolicyDocument;
  stored: StaffPolicyVersion | null;
  initial: VersionDraft;
  onCreated?: (id: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<VersionDraft>(initial);
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const create = useAdminAction('admin.policy_version_create', {
    target: doc.policy_key,
    onOutcome: (o) => {
      refresh();
      if (o.kind === 'applied' && o.data && onCreated) onCreated((o.data as StaffPolicyVersion).id);
    },
  });
  const update = useAdminAction('admin.policy_version_update', {
    target: stored?.id,
    onOutcome: () => {
      refresh();
      if (stored) void queryClient.invalidateQueries({ queryKey: ['admin.policy_version_get'] });
    },
  });
  const action = stored ? update : create;
  const busy = action.state.status === 'busy';
  const result = writeOf(draft);
  const problems = 'problems' in result ? result.problems : [];
  const value = 'value' in result ? result.value : null;
  const patch = stored && value ? patchOf(stored, value) : null;
  const unchanged = stored ? !patch || Object.keys(patch).length === 0 : false;
  const err = (p: DraftProblem) => (tried && problems.includes(p) ? t(problemKey(p)) : undefined);
  const setText = (field: 'title' | 'body' | 'summary', l: PolicyLocale, text: string) =>
    setDraft((d) => ({ ...d, [field]: { ...d[field], [l]: text } }));

  const submit = (reason: string) => {
    setDialog(false);
    if (!value) return;
    if (stored && patch)
      void update.run({ path: { version_id: stored.id }, body: { ...patch, reason }, reason, ifMatch: ifMatchOf(stored.version) });
    else void create.run({ path: { policy_key: doc.policy_key as PolicyKey }, body: { ...value, reason }, reason });
  };

  return (
    <form
      className="adm-form"
      noValidate
      data-testid="policy-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!value || unchanged || busy) return;
        action.reset();
        setDialog(true);
      }}
    >
      <TextField
        label={t('admin.policies.field.label')}
        hint={t('admin.policies.field.labelHint')}
        error={err('label')}
        value={draft.label}
        dir="ltr"
        maxLength={20}
        autoComplete="off"
        onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
      />
      {POLICY_LOCALES.map((l) => {
        const dir = l === 'fa' ? 'rtl' : 'ltr';
        const lang = t(`admin.policies.locale.${l}`);
        return (
          <fieldset key={l} className="adm-choices">
            <legend>{lang}</legend>
            <TextField
              label={t('admin.policies.field.title', { locale: lang })}
              error={err(`title.${l}`)}
              value={draft.title[l]}
              dir={dir}
              lang={l}
              maxLength={200}
              onChange={(e) => setText('title', l, e.target.value)}
            />
            <TextField
              multiline
              rows={12}
              label={t('admin.policies.field.body', { locale: lang })}
              hint={t('admin.policies.field.bodyHint')}
              error={err(`body.${l}`)}
              value={draft.body[l]}
              dir={dir}
              lang={l}
              maxLength={60_000}
              onChange={(e) => setText('body', l, e.target.value)}
            />
            <TextField
              multiline
              rows={2}
              label={t('admin.policies.field.summary', { locale: lang })}
              hint={t('admin.policies.field.summaryHint')}
              error={err(`summary.${l}`)}
              value={draft.summary[l]}
              dir={dir}
              lang={l}
              maxLength={1000}
              onChange={(e) => setText('summary', l, e.target.value)}
            />
          </fieldset>
        );
      })}
      <div className="adm-actions">
        <Button type="submit" variant="primary" disabled={unchanged} loading={busy}>
          {stored ? t('admin.policies.saveDraft') : t('admin.policies.createDraft')}
        </Button>
        {stored ? (
          <Button type="button" variant="ghost" disabled={unchanged} onClick={() => setDraft(initial)}>
            {t('admin.policies.undo')}
          </Button>
        ) : null}
      </div>
      <ActionNotice
        state={action.state}
        applied={stored ? t('admin.policies.saved') : t('admin.policies.created')}
        onReload={stored ? () => void queryClient.invalidateQueries({ queryKey: ['admin.policy_version_get'] }) : undefined}
      />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="policy_edit"
        title={
          stored
            ? t('admin.policies.dialog.save', { label: stored.policy_version })
            : t('admin.policies.dialog.create', { doc: policyName(doc.policy_key, t) })
        }
        confirmLabel={stored ? t('admin.policies.saveDraft') : t('admin.policies.createDraft')}
        summary={<p className="adm-muted">{t('admin.policies.draftNote')}</p>}
        onSubmit={submit}
        name="policy-draft"
      />
    </form>
  );
}

function PublishPanel({ doc, version }: { doc: StaffPolicyDocument; version: StaffPolicyVersion }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const queryClient = useQueryClient();
  const session = useSession();
  const tz = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const mode: ReconsentMode = doc.reconsent_mode;
  const [p, setP] = useState<PublishDraft>(() => ({
    when: 'approval',
    day: dayIn(tz, 1),
    time: '00:00',
    reconsent: false,
    action: 'keep',
  }));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState<{ effective_at: string; requires_reconsent: boolean; reconsent_action?: 'keep' | 'pause' } | null>(
    null,
  );
  const publish = useAdminAction('admin.policy_version_publish', {
    target: version.id,
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
  const result = publishOf(p, mode, tz);
  const problem = 'problem' in result ? result.problem : null;
  const otherScheduled = scheduled(doc);
  const set = (patch: Partial<PublishDraft>) => setP((x) => ({ ...x, ...patch }));

  return (
    <section aria-labelledby={`${uid}-p`} className="adm-panel" data-testid="policy-publish">
      <h3 id={`${uid}-p`} className="adm-section-title">
        {t('admin.policies.publish.title')}
      </h3>
      {otherScheduled ? (
        <Banner tone="info" text={t('admin.policies.publish.scheduledExists', { label: otherScheduled.policy_version })} />
      ) : null}
      <form
        className="adm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!('value' in result)) return;
          publish.reset();
          setDialog(result.value);
        }}
      >
        <fieldset className="adm-choices">
          <legend>{t('admin.policies.publish.when')}</legend>
          {(['approval', 'at'] as const).map((w) => (
            <label key={w} className="adm-radio">
              <input type="radio" name={`${uid}-when`} value={w} checked={p.when === w} onChange={() => set({ when: w })} />
              {t(`admin.policies.publish.when_${w}`)}
            </label>
          ))}
          {p.when === 'at' ? (
            <div className="adm-actions">
              <TextField
                type="date"
                label={t('admin.policies.publish.day')}
                value={p.day}
                min={dayIn(tz)}
                error={tried && problem ? t(`admin.policies.publish.problem_${problem}`) : undefined}
                onChange={(e) => set({ day: e.target.value })}
              />
              <TextField
                type="time"
                label={t('admin.policies.publish.time')}
                hint={t('admin.policies.publish.zone', { zone: tz })}
                value={p.time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </div>
          ) : (
            <p className="adm-muted">{t('admin.policies.publish.approvalHint')}</p>
          )}
        </fieldset>
        <Check checked={p.reconsent} onChange={(e) => set({ reconsent: e.target.checked })}>
          {t('admin.policies.publish.reconsent')}
        </Check>
        <p className="adm-muted">{t(`admin.policies.publish.reconsentEffect.${mode}` as MessageKey)}</p>
        {offersReconsentAction(mode, p.reconsent) ? (
          <fieldset className="adm-choices" data-testid="reconsent-action">
            <legend>{t('admin.policies.publish.actionLegend')}</legend>
            {RECONSENT_ACTIONS.map((a) => (
              <label key={a} className="adm-radio">
                <input type="radio" name={`${uid}-action`} value={a} checked={p.action === a} onChange={() => set({ action: a })} />
                {actionLabel(a, t)}
              </label>
            ))}
            <p className="adm-muted">{t(`admin.policies.publish.actionHint.${p.action}`)}</p>
          </fieldset>
        ) : null}
        <div className="adm-actions">
          <Button type="submit" variant="primary" loading={publish.state.status === 'busy'}>
            {t('admin.policies.publish.submit')}
          </Button>
        </div>
      </form>
      <ActionNotice state={publish.state} />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind="policy_publish"
        title={t('admin.policies.publish.dialog', { doc: policyName(doc.policy_key, t), label: version.policy_version })}
        confirmLabel={t('admin.policies.publish.submit')}
        summary={
          dialog ? (
            <>
              <p>
                {p.when === 'approval'
                  ? t('admin.policies.publish.summaryApproval')
                  : t('admin.policies.publish.summaryAt', { at: f.date(dialog.effective_at, 'dateTime') })}
              </p>
              <p>
                {dialog.requires_reconsent
                  ? dialog.reconsent_action
                    ? t('admin.policies.reconsentWith', { action: actionLabel(dialog.reconsent_action, t) })
                    : t('admin.policies.publish.summaryReconsent')
                  : t('admin.policies.publish.summaryNoReconsent')}
              </p>
              <p className="adm-muted">{t('admin.policies.publish.fourEyes')}</p>
            </>
          ) : null
        }
        onSubmit={(reason) => {
          // "As soon as approved" is the time of sending, not of opening the dialog (the backend refuses a time more
          // than a minute in the past).
          const body = dialog && p.when === 'approval' ? { ...dialog, effective_at: new Date().toISOString() } : dialog;
          setDialog(null);
          if (body) void publish.run({ path: { version_id: version.id }, body: { ...body, reason }, reason });
        }}
        name="policy-publish"
      />
    </section>
  );
}
