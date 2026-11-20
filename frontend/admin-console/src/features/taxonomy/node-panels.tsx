'use client';
// The node's synonyms, mappings and merge (AC12.T3-T5, Docs/23 A-TAX-02).
//   Synonyms   every synonym, alias, misspelling, local term, abbreviation and transliteration of the node (status
//              filter; AI suggestions wait as pending_review). Platform admins add (a transliteration names its script:
//              Latin-letter Persian is a "latin" transliteration) and deactivate; admins and moderators approve or
//              reject pending ones. Each write asks for a reason.
//   Mappings   the weighted mappings the node takes part in (symptom → system or task, part category → system,
//              task → part category), as source or target; admins add or change one (weight 0-100, status).
//   Merge      into another live node of the same type, never itself or a node below it (no circular parents). The
//              merge waits for a second administrator (four-eyes); once approved, a background job moves every
//              reference and the node becomes "merged" (its progress shows on Pending approvals and here, under the
//              merges this administrator asked for). The contract has no preview of the references (DI-35, BR-40).
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import type { Mapping, PendingChange, StaffTaxonomyNode, Synonym } from '@carpal/api-contracts';
import { ActionNotice, JobProgress, ReasonDialog, useAdminAction, type ActionState } from '@/components/admin';
import { statusLabel } from '@/features/approvals';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { localeName, typeName } from './node-editor';
import {
  buildTree,
  checkSynonym,
  enabledLocales,
  labelOf,
  mappingRoles,
  mergeTargets,
  parseWeight,
  SYNONYM_STATUSES,
  SYNONYM_TYPES,
  synonymBody,
  TERM_MAX,
  type MappingType,
  type SynonymDraft,
  type TaxonomyType,
} from './taxonomy-logic';
import { useTypeNodes } from './use-taxonomy';

// ---------------------------------------------------------------- synonyms (T4)

const EMPTY_SYNONYM: SynonymDraft = { term: '', locale: 'fa', type: '', script: '' };

export function SynonymsPanel({ node }: { node: StaffTaxonomyNode }) {
  const t = useT();
  const queryClient = useQueryClient();
  const roles = useSession().data?.staff?.roles ?? [];
  const canAdd = canCall('admin.synonym_create', roles);
  const canDecide = canCall('admin.synonym_decide', roles);
  const canDelete = canCall('admin.synonym_delete', roles);
  const [status, setStatus] = useState<string>('');
  const list = useApiQuery('admin.synonyms_list', {
    path: { node_id: node.id },
    query: { limit: 100, ...(status ? { status: status as Synonym['status'] } : {}) },
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin.synonyms_list'] });
  const [draft, setDraft] = useState<SynonymDraft>(EMPTY_SYNONYM);
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'approve' | 'reject' | 'delete'; synonym: Synonym } | null>(null);
  const [last, setLast] = useState<'add' | 'approve' | 'reject' | 'delete' | null>(null);
  const create = useAdminAction('admin.synonym_create', {
    target: node.id,
    onOutcome: () => {
      refresh();
      setDraft(EMPTY_SYNONYM);
      setTried(false);
    },
  });
  const decide = useAdminAction('admin.synonym_decide', { onOutcome: refresh });
  const remove = useAdminAction('admin.synonym_delete', { onOutcome: refresh });
  const action = (last === 'add' ? create : last === 'delete' ? remove : decide) as { state: ActionState<unknown> };
  const problems = checkSynonym(draft);
  const locales = enabledLocales(node);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems).length) return;
    setDialog({ kind: 'add' });
  };
  const send = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    setLast(d.kind);
    if (d.kind === 'add') void create.run({ path: { node_id: node.id }, body: synonymBody(draft, reason) as never, reason });
    else if (d.kind === 'delete') void remove.run({ path: { synonym_id: d.synonym.id }, reason });
    else void decide.run({ path: { synonym_id: d.synonym.id }, body: { decision: d.kind, reason }, reason });
  };

  const items = list.data?.items ?? [];
  return (
    <section className="adm-tax-panel" data-testid="synonyms-panel" aria-labelledby="tax-syn-title">
      <h3 id="tax-syn-title" className="adm-panel-title">
        {t('admin.taxonomy.synonyms.title')}
      </h3>
      <label className="cp-field adm-tax-filter">
        <span className="cp-field-label">{t('admin.taxonomy.synonyms.filter')}</span>
        <span className="cp-field-box">
          <select
            aria-label={t('admin.taxonomy.synonyms.filter')}
            className="cp-field-input adm-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('admin.taxonomy.synonyms.all')}</option>
            {SYNONYM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`admin.taxonomy.synonyms.status.${s}`)}
              </option>
            ))}
          </select>
        </span>
      </label>
      {list.isError ? (
        <Banner tone="danger" text={t('admin.taxonomy.loadFailed')} />
      ) : !list.data ? (
        <p role="status">{t('admin.work.loading')}</p>
      ) : items.length === 0 ? (
        <p className="adm-muted">{t('admin.taxonomy.synonyms.none')}</p>
      ) : (
        <table className="adm-tax-table">
          <caption className="sr-only">{t('admin.taxonomy.synonyms.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.taxonomy.synonyms.term')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.kind')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.language')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.source')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.state')}</th>
              <th scope="col">
                <span className="sr-only">{t('admin.taxonomy.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} data-testid="synonym" data-status={s.status} data-term={s.term}>
                <td lang={s.locale} dir={s.script === 'latin' || s.locale === 'en' ? 'ltr' : 'rtl'}>
                  {s.term}
                </td>
                <td>
                  {t(`admin.taxonomy.synonyms.types.${s.synonym_type}` as MessageKey)}
                  {s.script ? ` (${t(`admin.taxonomy.synonyms.script.${s.script}`)})` : ''}
                </td>
                <td>{localeName(s.locale, t)}</td>
                <td>{t(`admin.taxonomy.source.${s.source}` as MessageKey)}</td>
                <td>{t(`admin.taxonomy.synonyms.status.${s.status}` as MessageKey)}</td>
                <td>
                  <div className="adm-actions">
                    {s.status === 'pending_review' && canDecide ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'approve', synonym: s })}>
                          {t('admin.taxonomy.synonyms.approve')}
                        </Button>
                        <Button size="sm" onClick={() => setDialog({ kind: 'reject', synonym: s })}>
                          {t('admin.taxonomy.synonyms.reject')}
                        </Button>
                      </>
                    ) : null}
                    {s.status !== 'inactive' && canDelete ? (
                      <Button size="sm" variant="danger" onClick={() => setDialog({ kind: 'delete', synonym: s })}>
                        {t('admin.taxonomy.synonyms.deactivate')}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {action.state.status === 'done' || action.state.status === 'failed' ? (
        action.state.status === 'failed' && action.state.problem.code === 'DUPLICATE' ? (
          <Banner tone="danger" text={t('admin.taxonomy.synonyms.duplicate')} />
        ) : (
          <ActionNotice state={action.state} applied={t(`admin.taxonomy.synonyms.done.${last ?? 'add'}`)} />
        )
      ) : null}
      {canAdd && node.status !== 'merged' ? (
        <form className="adm-tax-add" onSubmit={submit} noValidate data-testid="synonym-add">
          <h4 className="adm-panel-title">{t('admin.taxonomy.synonyms.add')}</h4>
          <TextField
            label={t('admin.taxonomy.synonyms.term')}
            maxLength={TERM_MAX}
            dir="auto"
            value={draft.term}
            onChange={(e) => setDraft({ ...draft, term: e.target.value })}
            error={
              tried && problems.term
                ? t(problems.term === 'missing' ? 'admin.taxonomy.synonyms.termMissing' : 'admin.taxonomy.editor.tooLong', { n: TERM_MAX })
                : undefined
            }
          />
          <div className="adm-tax-row">
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.synonyms.language')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.synonyms.language')}
                  className="cp-field-input adm-select"
                  value={draft.locale}
                  onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
                >
                  {locales.map((l) => (
                    <option key={l} value={l}>
                      {localeName(l, t)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className={tried && problems.type ? 'cp-field is-error' : 'cp-field'}>
              <span className="cp-field-label">{t('admin.taxonomy.synonyms.kind')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.synonyms.kind')}
                  className="cp-field-input adm-select"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      type: e.target.value as SynonymDraft['type'],
                      script: e.target.value === 'transliteration' ? draft.script : '',
                    })
                  }
                >
                  <option value="">{t('admin.taxonomy.editor.choose')}</option>
                  {SYNONYM_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`admin.taxonomy.synonyms.types.${ty}`)}
                    </option>
                  ))}
                </select>
              </span>
              {tried && problems.type ? <span className="cp-field-hint">{t('admin.taxonomy.synonyms.kindMissing')}</span> : null}
            </label>
            {draft.type === 'transliteration' ? (
              <label className={tried && problems.script ? 'cp-field is-error' : 'cp-field'}>
                <span className="cp-field-label">{t('admin.taxonomy.synonyms.scriptLabel')}</span>
                <span className="cp-field-box">
                  <select
                    aria-label={t('admin.taxonomy.synonyms.scriptLabel')}
                    className="cp-field-input adm-select"
                    value={draft.script}
                    onChange={(e) => setDraft({ ...draft, script: e.target.value as SynonymDraft['script'] })}
                  >
                    <option value="">{t('admin.taxonomy.editor.choose')}</option>
                    <option value="latin">{t('admin.taxonomy.synonyms.script.latin')}</option>
                    <option value="native">{t('admin.taxonomy.synonyms.script.native')}</option>
                  </select>
                </span>
                {tried && problems.script ? <span className="cp-field-hint">{t('admin.taxonomy.synonyms.scriptMissing')}</span> : null}
              </label>
            ) : null}
          </div>
          <p className="adm-muted">{t('admin.taxonomy.synonyms.hint')}</p>
          <Button type="submit" variant="primary" loading={create.state.status === 'busy'}>
            {t('admin.taxonomy.synonyms.addAction')}
          </Button>
        </form>
      ) : null}
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={
          dialog?.kind === 'reject'
            ? 'rejection'
            : dialog?.kind === 'delete'
              ? 'removal'
              : dialog?.kind === 'approve'
                ? 'approval'
                : 'taxonomy_edit'
        }
        title={t(`admin.taxonomy.synonyms.dialog.${dialog?.kind ?? 'add'}`)}
        confirmLabel={t(`admin.taxonomy.synonyms.confirm.${dialog?.kind ?? 'add'}`)}
        confirmVariant={dialog?.kind === 'delete' || dialog?.kind === 'reject' ? 'danger' : 'primary'}
        summary={<p className="adm-panel-title">{dialog?.kind === 'add' ? draft.term : dialog ? dialog.synonym.term : ''}</p>}
        onSubmit={send}
        name="synonym"
      />
    </section>
  );
}

// ---------------------------------------------------------------- mappings (T5)

export function MappingsPanel({ node }: { node: StaffTaxonomyNode }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const canEdit = canCall('admin.mapping_upsert', useSession().data?.staff?.roles ?? []);
  const roles = mappingRoles(node.type as TaxonomyType);
  const asSource = useApiQuery(
    'admin.mappings_list',
    { query: { source_node_id: node.id, limit: 100 } },
    { enabled: roles.some((r) => r.end === 'source') },
  );
  const asTarget = useApiQuery(
    'admin.mappings_list',
    { query: { target_node_id: node.id, limit: 100 } },
    { enabled: roles.some((r) => r.end === 'target') },
  );
  const [role, setRole] = useState<string>(roles[0] ? `${roles[0].type}:${roles[0].end}` : '');
  const chosen = roles.find((r) => `${r.type}:${r.end}` === role) ?? null;
  const others = useTypeNodes(chosen?.other ?? null);
  const otherTypes = [...new Set(roles.map((r) => r.other))];
  const look0 = useTypeNodes(otherTypes[0] ?? null);
  const look1 = useTypeNodes(otherTypes[1] ?? null);
  const look2 = useTypeNodes(otherTypes[2] ?? null);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of [look0.data, look1.data, look2.data]) for (const n of d?.items ?? []) m.set(n.id, labelOf(n, locale));
    return m;
  }, [look0.data, look1.data, look2.data, locale]);
  const [otherId, setOtherId] = useState('');
  const [weight, setWeight] = useState('50');
  const [status, setStatus] = useState<'active' | 'pending_review' | 'inactive'>('active');
  const [tried, setTried] = useState(false);
  const [asking, setAsking] = useState(false);
  const upsert = useAdminAction('admin.mapping_upsert', {
    target: node.id,
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: ['admin.mappings_list'] }),
  });

  if (roles.length === 0)
    return (
      <section className="adm-tax-panel" data-testid="mappings-panel">
        <p className="adm-muted">{t('admin.taxonomy.mappings.notForType', { type: typeName(node.type, t) })}</p>
      </section>
    );

  const rows = [...(asSource.data?.items ?? []), ...(asTarget.data?.items ?? [])];
  const w = parseWeight(weight);
  const ready = !!chosen && !!otherId && w !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (ready) setAsking(true);
  };
  const send = (reason: string) => {
    setAsking(false);
    if (!chosen || w === null) return;
    const [source, target] = chosen.end === 'source' ? [node.id, otherId] : [otherId, node.id];
    void upsert.run({
      body: { source_node_id: source, target_node_id: target, mapping_type: chosen.type, weight: w, status, reason },
      reason,
    });
  };
  const edit = (m: Mapping) => {
    const end = m.source_node_id === node.id ? 'source' : 'target';
    setRole(`${m.mapping_type}:${end}`);
    setOtherId(end === 'source' ? m.target_node_id : m.source_node_id);
    setWeight(String(m.weight));
    setStatus((m.status ?? 'active') as typeof status);
  };

  return (
    <section className="adm-tax-panel" data-testid="mappings-panel" aria-labelledby="tax-map-title">
      <h3 id="tax-map-title" className="adm-panel-title">
        {t('admin.taxonomy.mappings.title')}
      </h3>
      {asSource.isError || asTarget.isError ? (
        <Banner tone="danger" text={t('admin.taxonomy.loadFailed')} />
      ) : rows.length === 0 ? (
        <p className="adm-muted">{t('admin.taxonomy.mappings.none')}</p>
      ) : (
        <table className="adm-tax-table">
          <caption className="sr-only">{t('admin.taxonomy.mappings.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.taxonomy.mappings.kind')}</th>
              <th scope="col">{t('admin.taxonomy.mappings.other')}</th>
              <th scope="col">{t('admin.taxonomy.mappings.weight')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.state')}</th>
              <th scope="col">{t('admin.taxonomy.synonyms.source')}</th>
              <th scope="col">
                <span className="sr-only">{t('admin.taxonomy.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const other = m.source_node_id === node.id ? m.target_node_id : m.source_node_id;
              return (
                <tr key={m.id} data-testid="mapping" data-type={m.mapping_type}>
                  <td>{t(`admin.taxonomy.mappings.types.${m.mapping_type}` as MessageKey)}</td>
                  <td>
                    <Bidi>{names.get(other) ?? other}</Bidi>
                  </td>
                  <td>{m.weight}</td>
                  <td>{t(`admin.taxonomy.synonyms.status.${m.status ?? 'active'}` as MessageKey)}</td>
                  <td>{t(`admin.taxonomy.source.${m.source}` as MessageKey)}</td>
                  <td>
                    {canEdit ? (
                      <Button size="sm" onClick={() => edit(m)}>
                        {t('admin.taxonomy.mappings.edit')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {canEdit && node.status !== 'merged' ? (
        <form className="adm-tax-add" onSubmit={submit} noValidate data-testid="mapping-add">
          <h4 className="adm-panel-title">{t('admin.taxonomy.mappings.add')}</h4>
          <div className="adm-tax-row">
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.mappings.kind')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.mappings.kind')}
                  className="cp-field-input adm-select"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setOtherId('');
                  }}
                >
                  {roles.map((r) => (
                    <option key={`${r.type}:${r.end}`} value={`${r.type}:${r.end}`}>
                      {t(`admin.taxonomy.mappings.types.${r.type}`)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className={tried && !otherId ? 'cp-field is-error' : 'cp-field'}>
              <span className="cp-field-label">
                {chosen ? t('admin.taxonomy.mappings.otherOf', { type: typeName(chosen.other, t) }) : t('admin.taxonomy.mappings.other')}
              </span>
              <span className="cp-field-box">
                <select
                  aria-label={
                    chosen ? t('admin.taxonomy.mappings.otherOf', { type: typeName(chosen.other, t) }) : t('admin.taxonomy.mappings.other')
                  }
                  className="cp-field-input adm-select"
                  value={otherId}
                  onChange={(e) => setOtherId(e.target.value)}
                >
                  <option value="">{t('admin.taxonomy.editor.choose')}</option>
                  {(others.data?.items ?? [])
                    .filter((n) => n.status === 'active')
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {labelOf(n, locale)} ({n.slug})
                      </option>
                    ))}
                </select>
              </span>
              {tried && !otherId ? <span className="cp-field-hint">{t('admin.taxonomy.mappings.otherMissing')}</span> : null}
            </label>
          </div>
          <div className="adm-tax-row">
            <TextField
              label={t('admin.taxonomy.mappings.weight')}
              hint={t('admin.taxonomy.mappings.weightHint')}
              inputMode="numeric"
              dir="ltr"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              error={tried && w === null ? t('admin.taxonomy.mappings.weightRange') : undefined}
            />
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.synonyms.state')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.synonyms.state')}
                  className="cp-field-input adm-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                >
                  {(['active', 'pending_review', 'inactive'] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`admin.taxonomy.synonyms.status.${s}`)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          </div>
          <Button type="submit" variant="primary" loading={upsert.state.status === 'busy'}>
            {t('admin.taxonomy.mappings.save')}
          </Button>
          {upsert.state.status === 'done' || upsert.state.status === 'failed' ? (
            upsert.state.status === 'failed' && upsert.state.problem.code === 'TAXONOMY_MISMATCH' ? (
              <Banner tone="danger" text={t('admin.taxonomy.mappings.mismatch')} />
            ) : (
              <ActionNotice state={upsert.state} applied={t('admin.taxonomy.mappings.saved')} />
            )
          ) : null}
        </form>
      ) : null}
      <ReasonDialog
        open={asking}
        onClose={() => setAsking(false)}
        kind="taxonomy_edit"
        title={t('admin.taxonomy.mappings.saveTitle')}
        confirmLabel={t('admin.taxonomy.mappings.save')}
        summary={
          <p>
            {chosen ? t(`admin.taxonomy.mappings.types.${chosen.type as MappingType}`) : ''} · {names.get(otherId) ?? ''} · {w ?? ''}
          </p>
        }
        onSubmit={send}
        name="mapping"
      />
    </section>
  );
}

// ---------------------------------------------------------------- merge (T3)

export function MergePanel({
  node,
  nodes,
  onMerged,
}: {
  node: StaffTaxonomyNode;
  nodes: readonly StaffTaxonomyNode[];
  onMerged: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const roles = useSession().data?.staff?.roles ?? [];
  const canMerge = canCall('admin.taxonomy_merge', roles);
  const index = useMemo(() => buildTree(nodes, locale), [nodes, locale]);
  const targets = useMemo(() => mergeTargets(index, node), [index, node]);
  const [into, setInto] = useState('');
  const [tried, setTried] = useState(false);
  const [asking, setAsking] = useState(false);
  const merge = useAdminAction('admin.taxonomy_merge', { target: node.id });
  // The merges this administrator asked for, with the job once a second administrator approved (BR-21 list).
  const mine = useApiQuery('admin.four_eyes_list', { query: { mine: true, limit: 50 } }, { enabled: canMerge, refetchInterval: 15_000 });
  const myMerges = (mine.data?.items ?? []).filter((c: PendingChange) => c.op_id === 'admin.taxonomy_merge').slice(0, 5);
  const target = targets.find((n) => n.id === into) ?? null;

  if (node.status === 'merged') {
    const survivor = nodes.find((n) => n.id === node.merged_into_id);
    return (
      <section className="adm-tax-panel" data-testid="merge-panel" data-merged="true">
        <Banner
          tone="info"
          text={t('admin.taxonomy.merge.already', { into: survivor ? labelOf(survivor, locale) : (node.merged_into_id ?? '') })}
        />
      </section>
    );
  }
  return (
    <section className="adm-tax-panel" data-testid="merge-panel" aria-labelledby="tax-merge-title">
      <h3 id="tax-merge-title" className="adm-panel-title">
        {t('admin.taxonomy.merge.title')}
      </h3>
      <p>{t('admin.taxonomy.merge.text')}</p>
      <ul className="adm-tax-effects">
        <li>{t('admin.taxonomy.merge.effectReferences')}</li>
        <li>{t('admin.taxonomy.merge.effectStatus')}</li>
        <li>{t('admin.taxonomy.merge.effectFourEyes')}</li>
      </ul>
      <p className="adm-muted">{t('admin.taxonomy.merge.noPreview')}</p>
      {!canMerge ? (
        <p>{t('admin.taxonomy.merge.adminOnly')}</p>
      ) : (
        <>
          <label className={tried && !into ? 'cp-field is-error' : 'cp-field'}>
            <span className="cp-field-label">{t('admin.taxonomy.merge.into', { type: typeName(node.type, t) })}</span>
            <span className="cp-field-box">
              <select
                aria-label={t('admin.taxonomy.merge.into', { type: typeName(node.type, t) })}
                className="cp-field-input adm-select"
                value={into}
                onChange={(e) => setInto(e.target.value)}
              >
                <option value="">{t('admin.taxonomy.editor.choose')}</option>
                {targets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {labelOf(n, locale)} ({n.slug})
                  </option>
                ))}
              </select>
            </span>
            <span className="cp-field-hint">{t('admin.taxonomy.merge.cycleGuard')}</span>
          </label>
          <Button
            variant="danger"
            loading={merge.state.status === 'busy'}
            onClick={() => {
              setTried(true);
              if (into) {
                merge.reset();
                setAsking(true);
              }
            }}
          >
            {t('admin.taxonomy.merge.action')}
          </Button>
        </>
      )}
      {merge.state.status === 'done' || merge.state.status === 'failed' ? (
        merge.state.status === 'failed' && merge.state.problem.code === 'TAXONOMY_MISMATCH' ? (
          <Banner tone="danger" text={t('admin.taxonomy.merge.mismatch')} />
        ) : (
          <ActionNotice state={merge.state} />
        )
      ) : null}
      {myMerges.length ? (
        <div className="adm-tax-mine" data-testid="my-merges">
          <h4 className="adm-panel-title">{t('admin.taxonomy.merge.mine')}</h4>
          <ul className="adm-mine">
            {myMerges.map((c) => (
              <li key={c.change_id} data-change={c.change_id} data-status={c.status}>
                <p>
                  <Bidi>{c.summary}</Bidi> · {statusLabel(c.status, t)} · {f.date(c.requested_at, 'dateTime')}
                </p>
                {c.status === 'approved' && c.job_id ? <JobProgress jobId={c.job_id} onDone={onMerged} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ReasonDialog
        open={asking}
        onClose={() => setAsking(false)}
        kind="taxonomy_merge"
        irreversible
        title={t('admin.taxonomy.merge.dialog')}
        confirmLabel={t('admin.taxonomy.merge.action')}
        confirmVariant="danger"
        summary={
          <p>
            {t('admin.taxonomy.merge.summary', {
              from: labelOf(node, locale),
              into: target ? labelOf(target, locale) : '',
            })}
          </p>
        }
        onSubmit={(reason) => {
          setAsking(false);
          void merge.run({ path: { node_id: node.id }, body: { into_node_id: into, reason }, reason });
        }}
        name="merge"
      />
    </section>
  );
}
