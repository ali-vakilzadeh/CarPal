'use client';
// My work (AC5.T7, A-DASH-01 queue part; the full dashboard is AC13): the changes waiting for this staff member's
// approval, then one tile per work queue the caller's roles may see (Docs/23 §1 principle 5: queues, not searches)
// with the number of open items, the age of the oldest and the SLA state of the most urgent (OQ-05 targets). Numbers
// refresh every minute while the page is open; a tile that cannot load says so and offers a retry.
import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import type { PendingChange } from '@carpal/api-contracts';
import { opLabel, SlaBadge } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon, type IconName } from '@/components/ds/icon';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { queueKey, queuesFor, summarizeQueue, type QueueId, type QueueSummary } from '@/lib/work/queues';
import { roleNames } from '@/features/shell';

const QUEUE_ICON: Record<QueueId, IconName> = {
  approvals: 'check',
  verification: 'shield',
  reviewApproval: 'star',
  reports: 'flag',
  cases: 'alert',
  disputes: 'comment',
  privacy: 'lock',
};

export const WORK_REFRESH_MS = 60_000;

export function MyWork() {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const session = useSession();
  const staff = session.data?.staff ?? null;
  const roles = staff?.roles ?? [];
  const queues = queuesFor(roles);
  const results = useQueries({
    queries: queues.map((q) => ({
      queryKey: queueKey(q.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => summarizeQueue(api, q, { timeZone: f.timeZone, signal }),
      refetchInterval: WORK_REFRESH_MS,
      staleTime: 30_000,
    })),
  });
  if (!staff) return null;
  const approvalsAt = queues.findIndex((q) => q.id === 'approvals');
  const approvals = approvalsAt >= 0 ? results[approvalsAt] : undefined;

  return (
    <div className="adm-page" data-testid="my-work">
      <h1 className="adm-page-title">{t('admin.work.title')}</h1>
      <p data-testid="home-roles">
        {t('admin.work.welcome', { name: staff.display_name })} {t('admin.console.home.roles', { roles: roleNames(roles, t) })}
      </p>
      {approvals ? (
        <section aria-labelledby="work-approvals" data-testid="work-approvals">
          <h2 id="work-approvals" className="adm-section-title">
            {t('admin.work.approvals.title')}
          </h2>
          {approvals.isError ? (
            <Banner tone="danger" text={t('admin.work.failed')} />
          ) : !approvals.data ? (
            <p role="status">{t('admin.work.loading')}</p>
          ) : approvals.data.count === 0 ? (
            <p>{t('admin.work.approvals.none')}</p>
          ) : (
            <ul className="adm-mine">
              {(approvals.data as QueueSummary<PendingChange>).urgent.map(({ item }) => (
                <li key={item.change_id}>
                  <p>
                    <Link href={`/approvals?change=${encodeURIComponent(item.change_id)}`}>{opLabel(item.op_id, t)}</Link>
                    {' · '}
                    <Bidi>{item.requested_by_display}</Bidi>
                  </p>
                  <p>
                    <Bidi>{item.summary}</Bidi>
                  </p>
                  <p className="adm-muted">{t('admin.approvals.expiresIn', { when: f.relative(item.expires_at) })}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <section aria-labelledby="work-queues">
        <h2 id="work-queues" className="adm-section-title">
          {t('admin.work.queues')}
        </h2>
        {queues.length === 0 ? (
          <p>{t('admin.work.noQueues')}</p>
        ) : (
          <ul className="adm-work">
            {queues.map((q, i) => {
              const r = results[i]!;
              return (
                <li key={q.id}>
                  <QueueTile
                    id={q.id}
                    href={q.href}
                    summary={r.data}
                    error={r.error as ApiProblem | null}
                    onRetry={() => void r.refetch()}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="adm-muted">{t('admin.work.refresh')}</p>
    </div>
  );
}

function QueueTile({
  id,
  href,
  summary,
  error,
  onRetry,
}: {
  id: QueueId;
  href: string;
  summary: QueueSummary | undefined;
  error: ApiProblem | null;
  onRetry: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const name = t(`admin.work.queue.${id}`);
  if (error)
    return (
      <div className="adm-work-tile" data-queue={id} data-state="error">
        <p className="adm-work-name">
          <Icon name={QUEUE_ICON[id]} size={20} />
          {name}
        </p>
        <p>{t('admin.work.failed')}</p>
        <Button size="sm" icon="refresh" onClick={onRetry}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  const count = summary ? (summary.capped ? t('admin.work.atLeast', { n: f.number(summary.count) }) : f.number(summary.count)) : '…';
  return (
    <Link href={href} className="adm-work-tile" data-queue={id} data-sla={summary?.state ?? 'none'} data-count={summary?.count ?? ''}>
      <span className="adm-work-name">
        <Icon name={QUEUE_ICON[id]} size={20} />
        {name}
      </span>
      <span className="adm-work-count" aria-label={summary ? t('admin.work.countLabel', { n: count }) : t('admin.work.loading')}>
        {count}
      </span>
      {summary && summary.count > 0 && summary.oldestStart !== null ? (
        <span className="adm-muted">{t('admin.work.oldest', { age: f.relative(summary.oldestStart) })}</span>
      ) : summary ? (
        <span className="adm-muted">{t('admin.work.empty')}</span>
      ) : null}
      {summary?.state ? (
        <SlaBadge
          state={summary.state}
          text={summary.overdue > 0 ? t('admin.work.overdue', { n: f.number(summary.overdue) }) : t(`admin.kit.sla.${summary.state}`)}
        />
      ) : null}
    </Link>
  );
}
