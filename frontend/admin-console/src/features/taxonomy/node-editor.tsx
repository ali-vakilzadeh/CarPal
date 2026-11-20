'use client';
// Node editor (AC12.T2, Docs/23 A-TAX-02): labels in every enabled locale (English and Persian required; the save is
// refused in the browser until each has one), description, slug, parent (only the types the database rule allows,
// never the node itself or a node below it), regions, order, status (Deprecate keeps existing references and hides
// the node from new choices) and the attributes the type allows. Create sends an Idempotency-Key (the client adds it);
// an edit sends If-Match from the node's version and explains a change made meanwhile with a Reload that keeps what
// was typed. Every save asks for a reason. Moderators read the node; only platform admins edit.
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import type { StaffTaxonomyNode } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { ifMatchOf } from '@/lib/api/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_KIND,
  buildTree,
  checkDraft,
  createBody,
  descendants,
  draftOf,
  EDITABLE_STATUSES,
  emptyDraft,
  enabledLocales,
  LABEL_MAX,
  labelOf,
  NEEDS_PARENT,
  PARENT_TYPES,
  suggestSlug,
  updateBody,
  type AttributeKey,
  type DraftProblem,
  type NodeDraft,
  type TaxonomyType,
} from './taxonomy-logic';
import { TAXONOMY_KEY, useTypeNodes } from './use-taxonomy';

export function localeName(locale: string, t: Translate): string {
  return locale === 'en' || locale === 'fa' ? t(`admin.taxonomy.locale.${locale}`) : locale;
}

export function typeName(type: string, t: Translate): string {
  return t(`admin.taxonomy.types.${type}` as MessageKey);
}

function problemText(p: DraftProblem, t: Translate): string {
  if (p.field === 'name')
    return p.problem === 'missing'
      ? t('admin.taxonomy.editor.nameMissing', { language: localeName(p.locale, t) })
      : t('admin.taxonomy.editor.tooLong', { n: LABEL_MAX });
  if (p.field === 'description') return t('admin.taxonomy.editor.tooLong', { n: 500 });
  if (p.field === 'slug') return t('admin.taxonomy.editor.slugPattern');
  if (p.field === 'parent') return t('admin.taxonomy.editor.parentRequired');
  if (p.field === 'regions') return t('admin.taxonomy.editor.regionsPattern');
  if (p.field === 'sortOrder') return t('admin.taxonomy.editor.sortRange');
  return t('admin.taxonomy.editor.attributeInvalid');
}

export interface NodeEditorProps {
  /** Edit this node, or create one of `type` under `parentId`. */
  node: StaffTaxonomyNode | null;
  type: TaxonomyType;
  parentId: string | null;
  canEdit: boolean;
  onSaved: (id: string) => void;
  onCancel?: () => void;
}

export function NodeEditor({ node, type, parentId, canEdit, onSaved, onCancel }: NodeEditorProps) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const locales = enabledLocales(node);
  const [draft, setDraft] = useState<NodeDraft>(() => (node ? draftOf(node) : emptyDraft(type, parentId)));
  const [base, setBase] = useState<StaffTaxonomyNode | null>(node);
  const [tried, setTried] = useState(false);
  const [asking, setAsking] = useState(false);
  // Another node (or the same one read again) resets the form; a Reload after 412 keeps the typed values.
  const [shownFor, setShownFor] = useState(node ? `${node.id}:${node.version}` : `new:${type}:${parentId ?? ''}`);
  const key = node ? `${node.id}:${node.version}` : `new:${type}:${parentId ?? ''}`;
  const [keepTyped, setKeepTyped] = useState(false);
  if (shownFor !== key) {
    setShownFor(key);
    if (!keepTyped) setDraft(node ? draftOf(node) : emptyDraft(type, parentId));
    setBase(node);
    setKeepTyped(false);
    setTried(false);
  }

  const parentTypes = PARENT_TYPES[draft.type];
  const [parentType, setParentType] = useState<TaxonomyType | null>(parentTypes[0] ?? null);
  const parents = useTypeNodes(parentType);
  const own = useTypeNodes(node && parentType === draft.type ? draft.type : null);
  const blockedParents = useMemo(() => {
    if (!node || !own.data) return new Set<string>();
    const below = descendants(buildTree(own.data.items, locale), node.id);
    below.add(node.id);
    return below;
  }, [node, own.data, locale]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
  const create = useAdminAction('admin.taxonomy_node_create', {
    onOutcome: (o) => {
      refresh();
      if (o.kind === 'applied') onSaved(o.data.id);
    },
  });
  const update = useAdminAction('admin.taxonomy_node_update', {
    target: node?.id,
    onOutcome: (o) => {
      refresh();
      if (o.kind === 'applied') onSaved(o.data.id);
    },
  });
  const action = node ? update : create;
  const busy = action.state.status === 'busy';
  const problems = checkDraft(draft, locales);
  const readOnly = !canEdit || node?.status === 'merged';

  const set = (patch: Partial<NodeDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setName = (l: string, v: string) => setDraft((d) => ({ ...d, names: { ...d.names, [l]: v } }));
  const setDescription = (l: string, v: string) => setDraft((d) => ({ ...d, descriptions: { ...d.descriptions, [l]: v } }));
  const setAttribute = (k: AttributeKey, v: string) => setDraft((d) => ({ ...d, attributes: { ...d.attributes, [k]: v } }));
  const fieldError = (match: (p: DraftProblem) => boolean) => {
    const p = tried ? problems.find(match) : undefined;
    return p ? problemText(p, t) : undefined;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.length || readOnly) return;
    create.reset();
    update.reset();
    setAsking(true);
  };
  const send = (reason: string) => {
    setAsking(false);
    if (node && base)
      void update.run({ path: { node_id: node.id }, body: updateBody(draft, locales, reason), reason, ifMatch: ifMatchOf(base.version) });
    else void create.run({ body: createBody(draft, locales, reason) as never, reason });
  };
  const reload = () => {
    setKeepTyped(true);
    action.reset();
    refresh();
  };

  const parentOptions = (parents.data?.items ?? []).filter((p) => p.status !== 'merged' && !blockedParents.has(p.id));

  return (
    <form className="adm-tax-editor" onSubmit={submit} noValidate data-testid="node-editor" data-mode={node ? 'edit' : 'create'}>
      {node?.status === 'merged' ? <Banner tone="info" text={t('admin.taxonomy.editor.mergedReadOnly')} /> : null}
      {!canEdit ? <p className="adm-muted">{t('admin.taxonomy.editor.readOnly')}</p> : null}
      {tried && problems.length ? (
        <div role="alert" data-testid="editor-problems">
          <Banner tone="danger" title={t('admin.taxonomy.editor.fix')} text={problems.map((p) => problemText(p, t)).join(' ')} />
        </div>
      ) : null}
      <fieldset className="adm-tax-fields" disabled={readOnly || busy}>
        <legend className="adm-panel-title">{t('admin.taxonomy.editor.labels')}</legend>
        {locales.map((l) => (
          <TextField
            key={l}
            label={t('admin.taxonomy.editor.name', { language: localeName(l, t) })}
            dir={l === 'fa' ? 'rtl' : 'ltr'}
            lang={l}
            maxLength={LABEL_MAX}
            required
            value={draft.names[l] ?? ''}
            onChange={(e) => setName(l, e.target.value)}
            error={fieldError((p) => p.field === 'name' && p.locale === l)}
          />
        ))}
        {locales.map((l) => (
          <TextField
            key={`d-${l}`}
            multiline
            rows={2}
            label={t('admin.taxonomy.editor.description', { language: localeName(l, t) })}
            dir={l === 'fa' ? 'rtl' : 'ltr'}
            lang={l}
            maxLength={500}
            value={draft.descriptions[l] ?? ''}
            onChange={(e) => setDescription(l, e.target.value)}
            error={fieldError((p) => p.field === 'description' && p.locale === l)}
          />
        ))}
      </fieldset>
      <fieldset className="adm-tax-fields" disabled={readOnly || busy}>
        <legend className="adm-panel-title">{t('admin.taxonomy.editor.placement')}</legend>
        <p className="adm-muted">{t('admin.taxonomy.editor.typeIs', { type: typeName(draft.type, t) })}</p>
        <div className="adm-tax-row">
          <TextField
            label={t('admin.taxonomy.editor.slug')}
            hint={t('admin.taxonomy.editor.slugHint')}
            dir="ltr"
            maxLength={80}
            value={draft.slug}
            onChange={(e) => set({ slug: e.target.value })}
            error={fieldError((p) => p.field === 'slug')}
          />
          {!node ? (
            <Button size="sm" onClick={() => set({ slug: suggestSlug(draft.names.en ?? '') })} disabled={!draft.names.en}>
              {t('admin.taxonomy.editor.suggestSlug')}
            </Button>
          ) : null}
        </div>
        {parentTypes.length > 1 ? (
          <label className="cp-field">
            <span className="cp-field-label">{t('admin.taxonomy.editor.parentType')}</span>
            <span className="cp-field-box">
              <select
                aria-label={t('admin.taxonomy.editor.parentType')}
                className="cp-field-input adm-select"
                value={parentType ?? ''}
                onChange={(e) => setParentType(e.target.value as TaxonomyType)}
              >
                {parentTypes.map((pt) => (
                  <option key={pt} value={pt}>
                    {typeName(pt, t)}
                  </option>
                ))}
              </select>
            </span>
          </label>
        ) : null}
        {parentTypes.length ? (
          <label className={fieldError((p) => p.field === 'parent') ? 'cp-field is-error' : 'cp-field'}>
            <span className="cp-field-label">{t('admin.taxonomy.editor.parent')}</span>
            <span className="cp-field-box">
              <select
                aria-label={t('admin.taxonomy.editor.parent')}
                className="cp-field-input adm-select"
                value={draft.parentId ?? ''}
                onChange={(e) => set({ parentId: e.target.value || null })}
                aria-invalid={fieldError((p) => p.field === 'parent') ? true : undefined}
              >
                <option value="">
                  {NEEDS_PARENT.has(draft.type) ? t('admin.taxonomy.editor.choose') : t('admin.taxonomy.editor.noParent')}
                </option>
                {draft.parentId && !parentOptions.some((p) => p.id === draft.parentId) ? (
                  <option value={draft.parentId}>{t('admin.taxonomy.editor.currentParent')}</option>
                ) : null}
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {labelOf(p, locale)} ({p.slug})
                  </option>
                ))}
              </select>
            </span>
            {fieldError((p) => p.field === 'parent') ? (
              <span className="cp-field-hint">{fieldError((p) => p.field === 'parent')}</span>
            ) : null}
          </label>
        ) : (
          <p className="adm-muted">{t('admin.taxonomy.editor.noParents')}</p>
        )}
        <TextField
          label={t('admin.taxonomy.editor.regions')}
          hint={t('admin.taxonomy.editor.regionsHint')}
          dir="ltr"
          value={draft.regions}
          onChange={(e) => set({ regions: e.target.value })}
          error={fieldError((p) => p.field === 'regions')}
        />
        <TextField
          label={t('admin.taxonomy.editor.sortOrder')}
          inputMode="numeric"
          dir="ltr"
          value={draft.sortOrder}
          onChange={(e) => set({ sortOrder: e.target.value })}
          error={fieldError((p) => p.field === 'sortOrder')}
        />
        <label className="cp-field">
          <span className="cp-field-label">{t('admin.taxonomy.editor.status')}</span>
          <span className="cp-field-box">
            <select
              aria-label={t('admin.taxonomy.editor.status')}
              className="cp-field-input adm-select"
              value={draft.status}
              onChange={(e) => set({ status: e.target.value as NodeDraft['status'] })}
            >
              {EDITABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`admin.taxonomy.status.${s}`)}
                </option>
              ))}
            </select>
          </span>
          <span className="cp-field-hint">{t('admin.taxonomy.editor.statusHint')}</span>
        </label>
      </fieldset>
      {ATTRIBUTE_KEYS[draft.type].length ? (
        <fieldset className="adm-tax-fields" disabled={readOnly || busy}>
          <legend className="adm-panel-title">{t('admin.taxonomy.editor.attributes')}</legend>
          {ATTRIBUTE_KEYS[draft.type].map((k) => {
            const kind = ATTRIBUTE_KIND[k];
            const label = t(`admin.taxonomy.attributes.${k}`);
            const error = fieldError((p) => p.field === 'attribute' && p.key === k);
            if (kind.kind === 'bool' || kind.kind === 'enum') {
              const values = kind.kind === 'bool' ? ['true', 'false'] : kind.values;
              return (
                <label key={k} className={error ? 'cp-field is-error' : 'cp-field'}>
                  <span className="cp-field-label">{label}</span>
                  <span className="cp-field-box">
                    <select
                      aria-label={label}
                      className="cp-field-input adm-select"
                      value={draft.attributes[k] ?? ''}
                      onChange={(e) => setAttribute(k, e.target.value)}
                    >
                      <option value="">{t('admin.taxonomy.editor.notSet')}</option>
                      {values.map((v) => (
                        <option key={v} value={v}>
                          {kind.kind === 'bool' ? t(v === 'true' ? 'admin.taxonomy.editor.yes' : 'admin.taxonomy.editor.no') : v}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              );
            }
            return (
              <TextField
                key={k}
                label={label}
                dir="ltr"
                inputMode={kind.kind === 'int' ? 'numeric' : undefined}
                value={draft.attributes[k] ?? ''}
                onChange={(e) => setAttribute(k, e.target.value)}
                error={error}
              />
            );
          })}
        </fieldset>
      ) : null}
      {readOnly ? null : (
        <div className="adm-actions">
          <Button type="submit" variant="primary" loading={busy}>
            {node ? t('admin.taxonomy.editor.save') : t('admin.taxonomy.editor.create')}
          </Button>
          {onCancel ? (
            <Button onClick={onCancel} disabled={busy}>
              {t('common.actions.cancel')}
            </Button>
          ) : null}
        </div>
      )}
      {action.state.status === 'done' || action.state.status === 'failed' ? (
        action.state.status === 'failed' && action.state.problem.code === 'TAXONOMY_MISMATCH' ? (
          <Banner tone="danger" text={t('admin.taxonomy.editor.mismatch')} />
        ) : action.state.status === 'failed' && action.state.problem.code === 'DUPLICATE' ? (
          <Banner tone="danger" text={t('admin.taxonomy.editor.duplicate')} />
        ) : (
          <ActionNotice
            state={action.state}
            applied={t(node ? 'admin.taxonomy.editor.saved' : 'admin.taxonomy.editor.created')}
            onReload={reload}
          />
        )
      ) : null}
      <ReasonDialog
        open={asking}
        onClose={() => setAsking(false)}
        kind="taxonomy_edit"
        title={node ? t('admin.taxonomy.editor.saveTitle') : t('admin.taxonomy.editor.createTitle')}
        confirmLabel={node ? t('admin.taxonomy.editor.save') : t('admin.taxonomy.editor.create')}
        summary={<p className="adm-panel-title">{draft.names[locale === 'fa' ? 'fa' : 'en'] || draft.slug}</p>}
        onSubmit={send}
        name="node-save"
      />
    </form>
  );
}
