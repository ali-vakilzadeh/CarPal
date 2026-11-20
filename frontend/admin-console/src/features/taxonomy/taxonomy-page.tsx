'use client';
// Taxonomy management (AC12, Docs/23 A-TAX-01 and A-TAX-02; platform admins edit, moderators read and decide AI
// synonyms). One type at a time (brands, models, series, engines, fuels, systems, tasks, part categories, symptoms,
// review tags, amenities), read whole with every status. Left: the tree, a flat list (label EN/FA, parent, status,
// missing translations, regions) or the "Missing translations" view, with a search by any label or slug and a status
// filter. Right: the node (details editor, synonyms, mappings, merge) or the form for a new node. A second tab shows
// the zero-result searches. Synonym search across nodes, usage counts, a pending-synonyms queue across nodes and the
// unmatched search terms are not in the contract (DI-35, BR-40).
import { useMemo } from 'react';
import type { StaffTaxonomyNode } from '@carpal/api-contracts';
import { DataTable, type Column } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useLocale, useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { NodeEditor, localeName, typeName } from './node-editor';
import { MappingsPanel, MergePanel, SynonymsPanel } from './node-panels';
import { SearchTerms } from './search-terms';
import {
  buildTree,
  childTypes,
  labelOf,
  missingTranslations,
  NEEDS_PARENT,
  isTaxonomyType,
  NODE_STATUSES,
  nodeMatches,
  TAXONOMY_TYPES,
  type TaxonomyType,
  type TreeIndex,
} from './taxonomy-logic';
import { useTaxonomyParams, useTypeNodes, type NodeTab, type TaxonomyView } from './use-taxonomy';

const TABS: readonly NodeTab[] = ['details', 'synonyms', 'mappings', 'merge'];

function StatusChip({ status }: { status: string }) {
  const t = useT();
  if (status === 'active') return null;
  return (
    <span className="adm-tax-chip" data-status={status}>
      {(NODE_STATUSES as readonly string[]).includes(status)
        ? t(`admin.taxonomy.status.${status as 'inactive'}`)
        : t('admin.kit.unknown', { value: status })}
    </span>
  );
}

function TreeLevel({
  index,
  parent,
  selected,
  onSelect,
  locale,
  depth,
}: {
  index: TreeIndex;
  parent: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  locale: string;
  depth: number;
}) {
  const nodes = index.children.get(parent) ?? [];
  if (!nodes.length) return null;
  return (
    <ul className="adm-tax-tree" data-depth={depth}>
      {nodes.map((n) => {
        const kids = index.children.get(n.id)?.length ?? 0;
        return (
          <li key={n.id} data-children={kids}>
            <button
              type="button"
              className="adm-tax-node"
              data-testid="tax-node"
              data-node={n.id}
              data-slug={n.slug}
              aria-current={n.id === selected ? 'true' : undefined}
              onClick={() => onSelect(n.id)}
            >
              <Bidi>{labelOf(n, locale)}</Bidi>
              {n.missing_locales.length ? (
                <span className="adm-tax-chip" data-status="missing">
                  !
                </span>
              ) : null}
              <StatusChip status={n.status} />
            </button>
            <TreeLevel index={index} parent={n.id} selected={selected} onSelect={onSelect} locale={locale} depth={depth + 1} />
          </li>
        );
      })}
    </ul>
  );
}

export function TaxonomyPage() {
  const t = useT();
  const locale = useLocale();
  const roles = useSession().data?.staff?.roles ?? [];
  const canEdit = canCall('admin.taxonomy_node_create', roles);
  const [p, set] = useTaxonomyParams();
  const data = useTypeNodes(p.type);
  const all = useMemo(() => data.data?.items ?? [], [data.data]);
  const index = useMemo(() => buildTree(all, locale), [all, locale]);
  const filtered = useMemo(
    () =>
      (p.view === 'missing' ? missingTranslations(all) : all).filter((n) => (!p.status || n.status === p.status) && nodeMatches(n, p.q)),
    [all, p.view, p.status, p.q],
  );
  const flat = p.view !== 'tree' || !!p.q || !!p.status;
  const selected = p.node && p.node !== 'new' ? (index.byId.get(p.node) ?? null) : null;
  const parentOfNew = p.node === 'new' ? p.parent : null;
  const newType: TaxonomyType =
    p.node === 'new' && p.parent ? (isTaxonomyType(p.childType) ? p.childType : (childTypeOf(p.parent, index, p.type) ?? p.type)) : p.type;

  const columns: Column<StaffTaxonomyNode>[] = [
    { id: 'en', header: localeName('en', t), pinned: true, cell: (n) => <span lang="en">{n.name_translations.en ?? '—'}</span> },
    { id: 'fa', header: localeName('fa', t), cell: (n) => <span lang="fa">{n.name_translations.fa ?? '—'}</span> },
    { id: 'slug', header: t('admin.taxonomy.editor.slug'), cell: (n) => <Bidi ltr>{n.slug}</Bidi> },
    {
      id: 'parent',
      header: t('admin.taxonomy.editor.parent'),
      cell: (n) => {
        const parent = n.parent_id ? index.byId.get(n.parent_id) : null;
        return parent ? <Bidi>{labelOf(parent, locale)}</Bidi> : n.parent_id ? t('admin.taxonomy.list.otherType') : '—';
      },
    },
    { id: 'status', header: t('admin.taxonomy.editor.status'), cell: (n) => t(`admin.taxonomy.status.${n.status}`) },
    {
      id: 'missing',
      header: t('admin.taxonomy.list.missing'),
      cell: (n) => (n.missing_locales.length ? n.missing_locales.map((l) => localeName(l, t)).join(', ') : '—'),
    },
    {
      id: 'regions',
      header: t('admin.taxonomy.editor.regions'),
      cell: (n) => (n.regions.length ? n.regions.join(', ') : t('admin.taxonomy.list.allRegions')),
    },
  ];

  const select = (id: string) => set({ node: id, parent: null });
  const children = selected ? childTypes(selected.type as TaxonomyType) : [];

  return (
    <div className="adm-page" data-testid="taxonomy-page">
      <h1 className="adm-page-title">{t('admin.taxonomy.title')}</h1>
      <div className="adm-tabs" role="tablist" aria-label={t('admin.taxonomy.title')}>
        {(['catalog', 'terms'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={p.section === s} className="adm-tab" onClick={() => set({ section: s })}>
            {t(`admin.taxonomy.sections.${s}`)}
          </button>
        ))}
      </div>
      {p.section === 'terms' ? (
        <SearchTerms />
      ) : (
        <>
          <div className="adm-tax-toolbar">
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.type')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.type')}
                  className="cp-field-input adm-select"
                  value={p.type}
                  onChange={(e) => set({ type: e.target.value as TaxonomyType, node: null, parent: null })}
                >
                  {TAXONOMY_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {typeName(ty, t)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.search')}</span>
              <span className="cp-field-box">
                <input
                  className="cp-field-input"
                  type="search"
                  dir="auto"
                  value={p.q}
                  placeholder={t('admin.taxonomy.searchHint')}
                  onChange={(e) => set({ q: e.target.value })}
                />
              </span>
            </label>
            <label className="cp-field">
              <span className="cp-field-label">{t('admin.taxonomy.editor.status')}</span>
              <span className="cp-field-box">
                <select
                  aria-label={t('admin.taxonomy.editor.status')}
                  className="cp-field-input adm-select"
                  value={p.status}
                  onChange={(e) => set({ status: e.target.value })}
                >
                  <option value="">{t('admin.taxonomy.allStatuses')}</option>
                  {NODE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`admin.taxonomy.status.${s}`)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <fieldset className="adm-radios adm-tax-views">
              <legend>{t('admin.taxonomy.view')}</legend>
              {(['tree', 'list', 'missing'] as const satisfies readonly TaxonomyView[]).map((v) => (
                <label key={v} className="adm-radio">
                  <input type="radio" name="tax-view" value={v} checked={p.view === v} onChange={() => set({ view: v })} />
                  {t(`admin.taxonomy.views.${v}`)}
                </label>
              ))}
            </fieldset>
            {canEdit && !NEEDS_PARENT.has(p.type) ? (
              <Button variant="primary" icon="plus" onClick={() => set({ node: 'new', parent: null, tab: 'details' })}>
                {t('admin.taxonomy.addTop', { type: typeName(p.type, t) })}
              </Button>
            ) : null}
          </div>
          {data.data?.capped ? <Banner tone="warn" text={t('admin.taxonomy.capped')} /> : null}
          <div className="adm-tax-layout">
            <section
              className="adm-tax-list"
              aria-label={t('admin.taxonomy.listLabel', { type: typeName(p.type, t) })}
              data-testid="tax-list"
            >
              {data.isError ? (
                <Banner tone="danger" text={t('admin.taxonomy.loadFailed')} />
              ) : !data.data ? (
                <p role="status">{t('admin.work.loading')}</p>
              ) : !flat ? (
                all.length ? (
                  <TreeLevel index={index} parent={null} selected={selected?.id ?? null} onSelect={select} locale={locale} depth={0} />
                ) : (
                  <p className="adm-muted">{t('admin.taxonomy.empty')}</p>
                )
              ) : (
                <DataTable
                  id={`taxonomy-${p.view}`}
                  caption={t('admin.taxonomy.listLabel', { type: typeName(p.type, t) })}
                  columns={columns}
                  rows={filtered}
                  rowKey={(n) => n.id}
                  emptyText={p.view === 'missing' ? t('admin.taxonomy.noMissing') : t('admin.taxonomy.noMatch')}
                  selectedKey={selected?.id ?? null}
                  onSelect={(n) => select(n.id)}
                />
              )}
            </section>
            <section className="adm-tax-node-panel" aria-label={t('admin.taxonomy.nodeLabel')} data-testid="tax-node-panel">
              {p.node === 'new' && canEdit ? (
                <>
                  <h2 className="adm-panel-title">
                    {parentOfNew
                      ? t('admin.taxonomy.addChildTitle', {
                          type: typeName(newType, t),
                          parent: index.byId.get(parentOfNew) ? labelOf(index.byId.get(parentOfNew)!, locale) : '',
                        })
                      : t('admin.taxonomy.addTop', { type: typeName(newType, t) })}
                  </h2>
                  <NodeEditor
                    node={null}
                    type={newType}
                    parentId={parentOfNew}
                    canEdit
                    onSaved={(id) => {
                      // A child of another type (a model under a brand) is listed under its own type.
                      if (newType !== p.type) set({ type: newType, node: id, parent: null, childType: null });
                      else set({ node: id, parent: null, childType: null });
                    }}
                    onCancel={() => set({ node: parentOfNew, parent: null, childType: null })}
                  />
                </>
              ) : selected ? (
                <>
                  <h2 className="adm-panel-title" data-testid="tax-node-title">
                    <Bidi>{labelOf(selected, locale)}</Bidi> <StatusChip status={selected.status} />
                  </h2>
                  <p className="adm-muted">
                    {typeName(selected.type, t)} · <Bidi ltr>{selected.slug}</Bidi>
                  </p>
                  {canEdit && selected.status !== 'merged' && children.length ? (
                    <div className="adm-actions">
                      {children.map((ct) => (
                        <Button
                          key={ct}
                          size="sm"
                          icon="plus"
                          onClick={() => set({ node: 'new', parent: selected.id, childType: ct, tab: 'details' })}
                        >
                          {t('admin.taxonomy.addChild', { type: typeName(ct, t) })}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <div className="adm-tabs" role="tablist" aria-label={t('admin.taxonomy.nodeLabel')}>
                    {TABS.map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={p.tab === tab}
                        className="adm-tab"
                        onClick={() => set({ tab })}
                      >
                        {t(`admin.taxonomy.tabs.${tab}`)}
                      </button>
                    ))}
                  </div>
                  <div role="tabpanel">
                    {p.tab === 'details' ? (
                      <NodeEditor
                        node={selected}
                        type={selected.type as TaxonomyType}
                        parentId={selected.parent_id}
                        canEdit={canEdit}
                        onSaved={() => undefined}
                      />
                    ) : p.tab === 'synonyms' ? (
                      <SynonymsPanel node={selected} />
                    ) : p.tab === 'mappings' ? (
                      <MappingsPanel node={selected} />
                    ) : (
                      <MergePanel node={selected} nodes={all} onMerged={() => void data.refetch()} />
                    )}
                  </div>
                </>
              ) : p.node && data.data ? (
                <p data-testid="tax-node-missing">{t('admin.taxonomy.notInType')}</p>
              ) : (
                <p className="adm-muted">{t('admin.taxonomy.pick')}</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** The type of a new child: the URL's parent is in the loaded type; its first child type (a brand's models). */
function childTypeOf(parentId: string, index: TreeIndex, fallback: TaxonomyType): TaxonomyType | null {
  const parent = index.byId.get(parentId);
  if (!parent) return fallback;
  return childTypes(parent.type as TaxonomyType)[0] ?? null;
}
