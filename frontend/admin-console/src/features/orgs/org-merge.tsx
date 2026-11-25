'use client';
// Merge duplicate (AC14-2, Docs/23 A-ORG-02, backend S22, BR-08): an administrator chooses the organization that stays
// (found by name or pasted id), reads the preview (admin.org_merge_preview: per module and reference the records that
// would move, be kept, merged, retired or block it, with conflicts; it changes nothing) and sends the merge for a
// second administrator (admin.org_merge, 4EYES + ASYNC: the approval starts the organization_merge job that applies every
// reference in one transaction, marks this organization merged and takes its profiles off publication; who may act
// for it never carries over). A reference with the refuse rule and live rows (an open assist session) blocks it.
import { useId, useState } from 'react';
import type { OrgMergePreview } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { enumLabel, isId } from '@/features/moderation';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { label, ORG_TYPES, type OrgHead } from './org-logic';

const RULES = ['move', 'keep_target', 'merge', 'retire', 'refuse', 'history'] as const;

/** The merge may be sent: a preview without blocking references, into another live organization. */
export function mergeReady(p: OrgMergePreview | undefined): boolean {
  return !!p && p.blocked_by.length === 0 && p.into.status !== 'merged' && p.organization.id !== p.into.id;
}

export function MergePanel({ org }: { org: OrgHead }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const allowed = canCall('admin.org_merge', session.data?.staff?.roles ?? []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [searched, setSearched] = useState('');
  const [idText, setIdText] = useState('');
  const [into, setInto] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const search = useApiQuery('admin.orgs_search', { body: { name: searched, limit: 10 } }, { enabled: open && searched.length >= 2 });
  const preview = useApiQuery(
    'admin.org_merge_preview',
    into ? { path: { org_id: org.id }, query: { into_organization_id: into } } : undefined,
    { enabled: !!into, retry: false },
  );
  const action = useAdminAction('admin.org_merge', { target: org.id });
  if (!allowed || org.status === 'merged') return null;
  if (!open)
    return (
      <Button
        size="sm"
        variant="secondary"
        icon="copy"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        {t('admin.orgs.merge.open')}
      </Button>
    );
  const hits = (search.data?.items ?? []).filter((o) => o.id !== org.id && o.status !== 'merged');
  const p = preview.data;
  return (
    <section className="adm-panel adm-stack adm-merge" data-testid="merge-panel" aria-labelledby={`${uid}-t`}>
      <h2 id={`${uid}-t`} className="adm-subtitle">
        {t('admin.orgs.merge.title', { name: org.name })}
      </h2>
      <p className="adm-muted">{t('admin.orgs.merge.intro')}</p>
      <form
        className="adm-search"
        role="search"
        aria-label={t('admin.orgs.merge.find')}
        onSubmit={(e) => {
          e.preventDefault();
          setSearched(name.trim());
        }}
      >
        <TextField
          label={t('admin.orgs.merge.byName')}
          value={name}
          maxLength={120}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="secondary" icon="search">
          {t('admin.orgs.search.go')}
        </Button>
      </form>
      {hits.length ? (
        <fieldset className="adm-radios" data-testid="merge-hits">
          <legend>{t('admin.orgs.merge.choose')}</legend>
          {hits.map((o) => (
            <label key={o.id}>
              <input type="radio" name={`${uid}-into`} value={o.id} checked={into === o.id} onChange={() => setInto(o.id)} />{' '}
              <Bidi>{o.name}</Bidi> · {label(ORG_TYPES, 'admin.orgs.type', o.organization_type, t)}
              {o.city ? (
                <>
                  {' · '}
                  <Bidi>{o.city}</Bidi>
                </>
              ) : null}
            </label>
          ))}
        </fieldset>
      ) : searched.length >= 2 && search.isSuccess ? (
        <p className="adm-muted">{t('admin.orgs.merge.noHits')}</p>
      ) : null}
      <div className="adm-actions">
        <TextField
          label={t('admin.orgs.merge.byId')}
          value={idText}
          dir="ltr"
          maxLength={36}
          autoComplete="off"
          error={idText && !isId(idText) ? t('admin.orgs.search.idInvalid') : undefined}
          onChange={(e) => setIdText(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!isId(idText) || idText.trim().toLowerCase() === org.id}
          onClick={() => setInto(idText.trim().toLowerCase())}
        >
          {t('admin.orgs.merge.useId')}
        </Button>
      </div>
      {into && preview.isPending ? <p className="adm-muted">{t('admin.kit.table.loading')}</p> : null}
      {into && preview.isError ? <Banner tone="danger" text={t('admin.orgs.merge.previewFailed')} /> : null}
      {p ? (
        <div className="adm-stack" data-testid="merge-preview">
          <p>{t('admin.orgs.merge.line', { from: p.organization.name, into: p.into.name })}</p>
          <table className="adm-simple-table">
            <caption>{t('admin.orgs.merge.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.orgs.merge.col.reference')}</th>
                <th scope="col">{t('admin.orgs.merge.col.rule')}</th>
                <th scope="col">{t('admin.orgs.merge.col.count')}</th>
                <th scope="col">{t('admin.orgs.merge.col.conflicts')}</th>
              </tr>
            </thead>
            <tbody>
              {p.references.map((r) => (
                <tr key={`${r.module}:${r.reference}`} data-rule={r.rule}>
                  <td>
                    <Bidi ltr>{r.reference}</Bidi>
                  </td>
                  <td>{enumLabel(RULES, 'admin.orgs.merge.rule', r.rule, t)}</td>
                  <td>{f.number(r.count)}</td>
                  <td>{f.number(r.conflicts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.blocked_by.length ? (
            <Banner tone="danger" icon="alert" title={t('admin.orgs.merge.blockedTitle')}>
              <ul className="pwa-banner-text" data-testid="merge-blocked">
                {p.blocked_by.map((b) => (
                  <li key={b}>
                    <Bidi ltr>{b}</Bidi>
                  </li>
                ))}
              </ul>
              <p className="pwa-banner-text">{t('admin.orgs.merge.blockedText')}</p>
            </Banner>
          ) : null}
          <div className="adm-actions">
            <Button
              variant="danger"
              disabled={!mergeReady(p) || action.state.status === 'busy'}
              loading={action.state.status === 'busy'}
              onClick={() => setDialog(true)}
            >
              {t('admin.orgs.merge.send')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('admin.orgs.merge.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      <ActionNotice state={action.state} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="org_merge"
        title={t('admin.orgs.merge.dialog')}
        confirmLabel={t('admin.orgs.merge.send')}
        confirmVariant="danger"
        irreversible
        summary={
          p ? (
            <>
              <p>{t('admin.orgs.merge.line', { from: p.organization.name, into: p.into.name })}</p>
              <p className="adm-muted">{t('admin.orgs.merge.effect')}</p>
            </>
          ) : null
        }
        onSubmit={(reason) => {
          setDialog(false);
          if (!into) return;
          void action.run({ path: { org_id: org.id }, body: { into_organization_id: into, reason }, reason });
        }}
        name="org-merge"
      />
    </section>
  );
}
