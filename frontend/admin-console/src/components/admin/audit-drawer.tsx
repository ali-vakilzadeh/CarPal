'use client';
// AuditDrawer (AC5.T6, Docs/23 §1 principle 2, §3.1): the audit trail of the record on this page, opened with the
// "Audit trail" button or Shift+H. admin.audit_search is ADM-only (STF(ADM), rate-limited, and the search itself is
// audited), so it runs only when an ADM opens the drawer, for this entity and the last 92 days (the contract allows
// up to 93); other staff see "Audit visible to platform admins". Newer entries load with "Show more" (cursor).
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry } from '@carpal/api-contracts';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/shell/dialog';
import { useShortcut } from '@/features/shell';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useSession } from '@/lib/api/query';
import { parseReason } from '@/lib/config/reasons';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { problemText } from './four-eyes-banner';

const WINDOW_DAYS = 92;
const PAGE = 50;

export interface AuditDrawerProps {
  /** AuditLog.entity_type as the backend writes it (e.g. "pending_admin_change", "UserAccount"). */
  entityType: string;
  entityId: string;
  /** What the record is, for the title. */
  label?: string;
  /** Register Shift+H on this page (one drawer per page should). */
  shortcut?: boolean;
}

export function AuditDrawer({ entityType, entityId, label, shortcut = true }: AuditDrawerProps) {
  const t = useT();
  const session = useSession();
  const allowed = canCall('admin.audit_search', session.data?.staff?.roles ?? []);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open = openedAt !== null;
  useShortcut('audit', () => setOpenedAt(Date.now()), shortcut);
  return (
    <>
      <Button size="sm" variant="ghost" icon="list" onClick={() => setOpenedAt(Date.now())} aria-keyshortcuts="Shift+H">
        {t('admin.kit.audit.open')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpenedAt(null)}
        title={label ? t('admin.kit.audit.titleFor', { name: label }) : t('admin.kit.audit.title')}
        className="adm-drawer"
        name="audit"
      >
        {!open ? null : allowed ? (
          <AuditList entityType={entityType} entityId={entityId} openedAt={openedAt} />
        ) : (
          <p data-testid="audit-not-allowed">{t('admin.kit.audit.adminsOnly')}</p>
        )}
      </Dialog>
    </>
  );
}

function AuditList({ entityType, entityId, openedAt }: { entityType: string; entityId: string; openedAt: number }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const to = new Date(openedAt).toISOString();
  const from = new Date(openedAt - WINDOW_DAYS * 86_400_000).toISOString();
  const q = useInfiniteQuery<{ items: AuditEntry[]; next_cursor: string | null }, ApiProblem>({
    queryKey: ['admin.audit_search', entityType, entityId, from, to],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.api('admin.audit_search', {
        body: {
          entity_type: entityType,
          entity_id: entityId,
          from,
          to,
          limit: PAGE,
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        signal,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 0,
  });

  if (q.isPending) return <p role="status">{t('admin.kit.audit.loading')}</p>;
  if (q.isError)
    return (
      <div className="adm-table-error">
        <Banner tone="danger" text={problemText(q.error, t)} />
        <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  const items = q.data.pages.flatMap((p) => p.items);
  return (
    <div data-testid="audit-list">
      <p className="adm-muted">{t('admin.kit.audit.window', { days: f.number(WINDOW_DAYS) })}</p>
      {items.length === 0 ? (
        <p role="status">{t('admin.kit.audit.empty')}</p>
      ) : (
        <ol className="adm-timeline">
          {items.map((e) => {
            const reason = e.reason ? parseReason(e.reason) : null;
            return (
              <li key={e.id} data-audit={e.action}>
                <p className="adm-timeline-head">
                  <time dateTime={e.created_at}>{f.date(e.created_at, 'dateTime')}</time>
                  <span className="adm-muted">
                    {' · '}
                    <Bidi>{e.actor_display}</Bidi> ({t(`admin.kit.audit.actor.${e.actor_type}` as MessageKey)})
                  </span>
                </p>
                <p className="adm-timeline-title">
                  <Bidi ltr>{e.action}</Bidi>
                </p>
                {e.previous_state_summary || e.new_state_summary ? (
                  <dl className="adm-audit-states">
                    {e.previous_state_summary ? (
                      <div>
                        <dt>{t('admin.kit.audit.before')}</dt>
                        <dd>
                          <Bidi>{e.previous_state_summary}</Bidi>
                        </dd>
                      </div>
                    ) : null}
                    {e.new_state_summary ? (
                      <div>
                        <dt>{t('admin.kit.audit.after')}</dt>
                        <dd>
                          <Bidi>{e.new_state_summary}</Bidi>
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                {reason ? (
                  <p className="adm-timeline-detail">
                    {t('admin.kit.audit.reason')}{' '}
                    {reason.code ? <strong>{t(`admin.reasons.codes.${reason.code}` as MessageKey)}</strong> : null}
                    {reason.note ? (
                      <>
                        {reason.code ? ' — ' : null}
                        <Bidi>{reason.note}</Bidi>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {q.hasNextPage ? (
        <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('admin.kit.audit.more')}
        </Button>
      ) : null}
    </div>
  );
}
