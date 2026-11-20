'use client';
// MCP clients and the MCP access log (AC13.T2/T3, Docs/23 A-MCP-01, A-MCP-02, Docs/40 §23.5; ADM only). Two tabs:
// - Clients: the registered clients (type, environment, status, how many scopes, resources and tools) and, for the
//   selected one, its facts, the access editor (a checkbox tree per field from the catalog, Docs/53; values the catalog
//   lacks stay under "Other") and its status. Saving sends only the changed lists with the client's version as
//   If-Match and waits for a second administrator (202, FourEyesBanner); a change made meanwhile (412) is explained
//   with a Reload that keeps the ticks. Suspend applies at once; Reactivate waits for a second administrator. Create,
//   Rotate token, rate limits and a usage graph have no operation (DI-37); "Recent denials" opens the log for the client.
// - Access log: an audited search (client, resource or tool, decision, principal id, window); principals masked.
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { McpClientView } from '@carpal/api-contracts';
import { ActionNotice, AuditDrawer, CaseLayout, DataTable, ReasonDialog, useAdminAction, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { ifMatchOf } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { AccessLog } from './access-log';
import {
  ACCESS_FIELDS,
  accessChanges,
  catalogTree,
  clientStatusLabel,
  clientTypeLabel,
  draftOf,
  environmentLabel,
  statusAction,
  type AccessDraft,
  type AccessField,
} from './mcp-logic';

const LIST_KEY = ['admin.mcp_clients_list'] as const;
type Tab = 'clients' | 'log';

export function McpPage() {
  const t = useT();
  const params = useSearchParams();
  const pathname = usePathname();
  const tab: Tab = params.get('tab') === 'log' || params.get('log') ? 'log' : 'clients';
  const clients = useApiQuery('admin.mcp_clients_list', { query: { limit: 100 } }, { staleTime: 30_000 });
  return (
    <div className="adm-page" data-testid="mcp-page">
      <h1 className="adm-page-title">{t('admin.mcp.title')}</h1>
      <nav className="adm-tabs" aria-label={t('admin.mcp.tabsLabel')}>
        <Link href={pathname} aria-current={tab === 'clients' ? 'page' : undefined} className="adm-tab" data-tab="clients">
          {t('admin.mcp.tab.clients')}
        </Link>
        <Link href={`${pathname}?tab=log`} aria-current={tab === 'log' ? 'page' : undefined} className="adm-tab" data-tab="log">
          {t('admin.mcp.tab.log')}
        </Link>
      </nav>
      {tab === 'clients' ? <ClientsPanel list={clients} /> : <AccessLog clients={clients.data?.items ?? []} />}
    </div>
  );
}

type Pending =
  | { kind: 'access'; clientId: string; body: Partial<AccessDraft>; diff: ReturnType<typeof accessChanges>['diff'] }
  | { kind: 'status'; clientId: string; next: 'suspended' | 'active' };

function ClientsPanel({ list }: { list: ReturnType<typeof useApiQuery<'admin.mcp_clients_list'>> }) {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const items = list.data?.items;
  const selectedId = params.get('client');
  const selected = items?.find((c) => c.id === selectedId) ?? null;
  const select = (c: McpClientView) => {
    const p = new URLSearchParams(params);
    p.set('client', c.id);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const [dialog, setDialog] = useState<Pending | null>(null);
  const [last, setLast] = useState<Pending | null>(null);
  // A new editor after a filed change: the ticks go back to the client's current lists.
  const [editorRound, setEditorRound] = useState(0);
  const reload = () => void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const action = useAdminAction('admin.mcp_client_update', {
    target: last?.clientId ?? '',
    onOutcome: () => {
      reload();
      if (last?.kind === 'access') setEditorRound((n) => n + 1);
    },
  });
  const busy = action.state.status === 'busy';
  const ask = (p: Pending) => {
    if (busy) return;
    action.reset();
    setDialog(p);
  };
  const submit = (reason: string) => {
    const p = dialog;
    const client = items?.find((c) => c.id === p?.clientId);
    if (!p || !client) return;
    setDialog(null);
    setLast(p);
    const body = p.kind === 'access' ? { ...p.body, reason } : { status: p.next, reason };
    void action.run({ path: { client_id: client.id }, body, reason, ifMatch: ifMatchOf(client.version) });
  };

  const columns: Column<McpClientView>[] = [
    { id: 'name', header: t('admin.mcp.col.name'), pinned: true, cell: (c) => <Bidi ltr>{c.name}</Bidi> },
    { id: 'type', header: t('admin.mcp.col.type'), cell: (c) => clientTypeLabel(c.client_type, t) },
    { id: 'environment', header: t('admin.mcp.col.environment'), cell: (c) => environmentLabel(c.environment, t) },
    { id: 'status', header: t('admin.mcp.col.status'), cell: (c) => <StatusBadge status={c.status} /> },
    { id: 'scopes', header: t('admin.mcp.col.scopes'), align: 'end', cell: (c, ctx) => ctx.digits(String(c.allowed_scopes.length)) },
    {
      id: 'resources',
      header: t('admin.mcp.col.resources'),
      align: 'end',
      cell: (c, ctx) => ctx.digits(String(c.allowed_resources.length)),
    },
    { id: 'tools', header: t('admin.mcp.col.tools'), align: 'end', cell: (c, ctx) => ctx.digits(String(c.allowed_tools.length)) },
    { id: 'rate', header: t('admin.mcp.col.rate'), defaultHidden: true, cell: (c) => <Bidi ltr>{c.rate_limit_policy}</Bidi> },
  ];

  const noticeFor = (kind: Pending['kind']) =>
    last && selected && last.clientId === selected.id && last.kind === kind ? (
      <ActionNotice state={action.state} applied={t('admin.mcp.applied')} onReload={reload} />
    ) : null;

  const dialogClient = dialog ? items?.find((c) => c.id === dialog.clientId) : undefined;

  return (
    <>
      <CaseLayout
        labels={{ list: t('admin.mcp.listLabel'), item: t('admin.mcp.itemLabel'), decision: t('admin.mcp.decisionLabel') }}
        list={
          <DataTable
            id="mcp-clients"
            caption={t('admin.mcp.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(c) => c.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.mcp.empty')}
            selectedKey={selected?.id ?? null}
            onSelect={select}
          />
        }
        item={
          selected ? (
            <ClientDetail
              key={`${selected.id}-${editorRound}`}
              client={selected}
              busy={busy}
              onSave={(body, diff) => ask({ kind: 'access', clientId: selected.id, body, diff })}
              notice={noticeFor('access')}
            />
          ) : (
            <p className="adm-muted">{t('admin.mcp.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.mcp.decisionLabel')}</h2>
            {selected ? (
              <StatusPanel
                client={selected}
                busy={busy}
                onAsk={(next) => ask({ kind: 'status', clientId: selected.id, next })}
                notice={noticeFor('status')}
              />
            ) : (
              <p className="adm-muted">{t('admin.mcp.pickFirst')}</p>
            )}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={
          dialog?.kind === 'access'
            ? 'mcp_access'
            : dialog?.kind === 'status' && dialog.next === 'suspended'
              ? 'mcp_suspend'
              : 'mcp_reactivate'
        }
        title={
          dialog?.kind === 'access'
            ? t('admin.mcp.dialog.accessTitle')
            : dialog?.kind === 'status' && dialog.next === 'suspended'
              ? t('admin.mcp.dialog.suspendTitle')
              : t('admin.mcp.dialog.reactivateTitle')
        }
        confirmLabel={dialog?.kind === 'status' && dialog.next === 'suspended' ? t('admin.mcp.suspend') : t('admin.mcp.dialog.request')}
        confirmVariant={dialog?.kind === 'status' && dialog.next === 'suspended' ? 'danger' : 'primary'}
        summary={
          dialog && dialogClient ? (
            <>
              <p>
                <Bidi ltr>{dialogClient.name}</Bidi>
              </p>
              {dialog.kind === 'access' ? (
                <ul className="adm-mcp-diff" data-testid="mcp-diff">
                  {dialog.diff.map((d) => (
                    <li key={d.field}>
                      <strong>{t(`admin.mcp.field.${d.field}` as MessageKey)}</strong>
                      {d.added.length ? (
                        <p>
                          {t('admin.mcp.dialog.added')} <Bidi ltr>{d.added.join(', ')}</Bidi>
                        </p>
                      ) : null}
                      {d.removed.length ? (
                        <p>
                          {t('admin.mcp.dialog.removed')} <Bidi ltr>{d.removed.join(', ')}</Bidi>
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : dialog.next === 'suspended' ? (
                <p className="adm-error">{t('admin.mcp.dialog.suspendEffect')}</p>
              ) : null}
              {dialog.kind === 'access' || dialog.next === 'active' ? <p className="adm-muted">{t('admin.mcp.fourEyes')}</p> : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="mcp"
      />
    </>
  );
}

function StatusBadge({ status }: { status: McpClientView['status'] }) {
  const t = useT();
  return (
    <Badge tone={status === 'active' ? 'success' : status === 'suspended' ? 'danger' : 'neutral'}>{clientStatusLabel(status, t)}</Badge>
  );
}

function StatusPanel({
  client,
  busy,
  onAsk,
  notice,
}: {
  client: McpClientView;
  busy: boolean;
  onAsk: (next: 'suspended' | 'active') => void;
  notice: ReactNode;
}) {
  const t = useT();
  const next = statusAction(client.status);
  const now = new Date();
  const logHref = `/mcp?${new URLSearchParams({ tab: 'log', client: client.id, decision: 'denied', window: '7', at: String(now.getTime()) }).toString()}`;
  return (
    <div className="adm-switch" data-testid="mcp-status">
      <p>
        {t('admin.mcp.now')} <StatusBadge status={client.status} />
      </p>
      {next === 'suspend' ? (
        <>
          <p className="adm-muted">{t('admin.mcp.suspendNote')}</p>
          <div className="adm-actions">
            <Button variant="danger" icon="alert" loading={busy} onClick={() => onAsk('suspended')}>
              {t('admin.mcp.suspend')}
            </Button>
          </div>
        </>
      ) : next === 'reactivate' ? (
        <>
          <p className="adm-muted">{t('admin.mcp.reactivateNote')}</p>
          <div className="adm-actions">
            <Button loading={busy} onClick={() => onAsk('active')}>
              {t('admin.mcp.reactivate')}
            </Button>
          </div>
        </>
      ) : (
        <p className="adm-muted">{t('admin.mcp.revokedNote')}</p>
      )}
      {notice}
      <p>
        <Link href={logHref} data-testid="mcp-denials">
          {t('admin.mcp.recentDenials')}
        </Link>
      </p>
      <p className="adm-muted">{t('admin.mcp.notInContract')}</p>
    </div>
  );
}

function ClientDetail({
  client,
  busy,
  onSave,
  notice,
}: {
  client: McpClientView;
  busy: boolean;
  onSave: (body: Partial<AccessDraft>, diff: ReturnType<typeof accessChanges>['diff']) => void;
  notice: ReactNode;
}) {
  const t = useT();
  const f = useFormat();
  const [draft, setDraft] = useState<AccessDraft>(() => draftOf(client));
  const changes = useMemo(() => accessChanges(client, draft), [client, draft]);
  const unchanged = changes.diff.length === 0;
  const toggle = (field: AccessField, value: string, on: boolean) =>
    setDraft((d) => ({ ...d, [field]: on ? [...d[field], value] : d[field].filter((v) => v !== value) }));
  const editable = client.status !== 'revoked';
  return (
    <article data-testid="mcp-client" data-client={client.name}>
      <h2 className="adm-panel-title">
        <Bidi ltr>{client.name}</Bidi>
      </h2>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.mcp.col.type')}</dt>
          <dd>{clientTypeLabel(client.client_type, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.mcp.col.environment')}</dt>
          <dd>{environmentLabel(client.environment, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.mcp.col.rate')}</dt>
          <dd>
            <Bidi ltr>{client.rate_limit_policy}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.mcp.geo')}</dt>
          <dd>{client.geo_restrictions.length ? <Bidi ltr>{client.geo_restrictions.join(', ')}</Bidi> : t('admin.mcp.geoNone')}</dd>
        </div>
        <div>
          <dt>{t('admin.mcp.version')}</dt>
          <dd>{f.number(client.version)}</dd>
        </div>
      </dl>
      <AuditDrawer entityType="mcp_client" entityId={client.id} label={client.name} />
      <form
        className="adm-form adm-mcp-editor"
        noValidate
        aria-labelledby="mcp-access-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (!unchanged && !busy && editable) onSave(changes.body, changes.diff);
        }}
      >
        <h3 id="mcp-access-title" className="adm-subtitle">
          {t('admin.mcp.access.title')}
        </h3>
        <p className="adm-muted">{t('admin.mcp.access.intro')}</p>
        {ACCESS_FIELDS.map((field) => (
          <AccessTree
            key={field}
            field={field}
            values={draft[field]}
            current={client[field]}
            disabled={!editable}
            onToggle={(v, on) => toggle(field, v, on)}
          />
        ))}
        <div className="adm-actions">
          <Button type="submit" disabled={unchanged || !editable} loading={busy}>
            {t('admin.mcp.access.save')}
          </Button>
          <Button type="button" variant="ghost" disabled={unchanged} onClick={() => setDraft(draftOf(client))}>
            {t('admin.mcp.access.undo')}
          </Button>
        </div>
        {unchanged ? (
          <p className="adm-muted">{t('admin.mcp.access.unchanged')}</p>
        ) : (
          <p className="adm-muted">{t('admin.mcp.fourEyes')}</p>
        )}
        {notice}
      </form>
    </article>
  );
}

function AccessTree({
  field,
  values,
  current,
  disabled,
  onToggle,
}: {
  field: AccessField;
  values: readonly string[];
  current: readonly string[];
  disabled: boolean;
  onToggle: (value: string, on: boolean) => void;
}) {
  const t = useT();
  const f = useFormat();
  const groups = useMemo(() => catalogTree(field, current), [field, current]);
  const chosen = new Set(values);
  return (
    <fieldset className="adm-mcp-field" data-field={field}>
      <legend>
        {t(`admin.mcp.field.${field}` as MessageKey)}{' '}
        <span className="adm-muted">{t('admin.mcp.access.count', { n: f.number(chosen.size) })}</span>
      </legend>
      {groups.map((g) => {
        const inGroup = g.values.filter((v) => chosen.has(v)).length;
        const name = g.domain ?? t('admin.mcp.access.other');
        return (
          <details key={g.domain ?? '_other'} className="adm-mcp-group" open={g.domain === null || undefined}>
            <summary>
              <Bidi ltr={g.domain !== null}>{name}</Bidi>{' '}
              <span className="adm-muted">
                {t('admin.mcp.access.groupCount', { n: f.number(inGroup), total: f.number(g.values.length) })}
              </span>
            </summary>
            {g.domain === null ? <p className="adm-muted">{t('admin.mcp.access.otherNote')}</p> : null}
            <div className="adm-mcp-values">
              {g.values.map((v) => (
                <Check key={v} checked={chosen.has(v)} disabled={disabled} onChange={(e) => onToggle(v, e.target.checked)}>
                  <Bidi ltr>{v}</Bidi>
                </Check>
              ))}
            </div>
          </details>
        );
      })}
    </fieldset>
  );
}
