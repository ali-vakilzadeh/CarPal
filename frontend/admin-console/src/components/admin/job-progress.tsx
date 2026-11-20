'use client';
// JobProgress (AC12.T3, GD-11): the background job an approved four-eyes change started (PendingChange.job_id, e.g. a
// taxonomy or organization merge), followed with admin.job_get every 3 seconds until it ends. Generic texts: the
// screen that started it says what the job does. Shown only to roles that may read admin-plane jobs (ADM, SUP);
// admin.job_get answers 404 for jobs the caller's roles cannot start.
import { useEffect, useRef } from 'react';
import { Banner } from '@/components/ds/banner';
import { useApiQuery, useSession } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';

export const JOB_DONE: readonly string[] = ['succeeded', 'failed', 'cancelled'];
const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
export const JOB_POLL_MS = 3_000;

export function JobProgress({ jobId, onDone }: { jobId: string; onDone?: (status: string) => void }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const allowed = canCall('admin.job_get', session.data?.staff?.roles ?? []);
  const job = useApiQuery(
    'admin.job_get',
    { path: { job_id: jobId } },
    {
      enabled: allowed,
      refetchInterval: (q) => (q.state.data && JOB_DONE.includes(q.state.data.status) ? false : JOB_POLL_MS),
    },
  );
  // Tell the screen once when the job ends (e.g. to read the merged node again).
  const reported = useRef(false);
  const ended = job.data && JOB_DONE.includes(job.data.status) ? job.data.status : null;
  useEffect(() => {
    if (!ended || reported.current) return;
    reported.current = true;
    onDone?.(ended);
  }, [ended, onDone]);
  if (!allowed) return null;
  if (job.isError)
    return (
      <p className="adm-muted" data-kit="job" data-job={jobId} data-status="unreadable">
        {t('admin.kit.job.unreadable')}
      </p>
    );
  const status = job.data?.status ?? 'queued';
  const tone = status === 'succeeded' ? 'success' : status === 'failed' || status === 'cancelled' ? 'danger' : 'info';
  return (
    <div data-kit="job" data-job={jobId} data-status={status} role="status" aria-live="polite">
      <Banner
        tone={tone}
        text={
          JOB_STATES.includes(status)
            ? t(`admin.kit.job.${status}` as MessageKey, { progress: f.number(job.data?.progress ?? 0) })
            : t('admin.kit.unknown', { value: status })
        }
      />
    </div>
  );
}
