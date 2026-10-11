// L10 jobs (41 §2.2; 40 §4.1 Job, ASYNC; 42 §7): every `202 Job` has a durable
// core.background_jobs row (owner, organization, status, progress, result)
// and a queue entry (BullMQ in full mode). The row is written in the use
// case's transaction; the queue entry is added after commit. Workers update
// status through JobRunner.
import type { Selectable } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import type { JobKind } from '#libs/contract/generated/enums.js';
import type { DB } from '#libs/db/index.js';
import type { JobQueue, QueuedJob } from '#libs/infra/index.js';
import { appMetrics } from '#libs/observability/index.js';
import type { TxRunner, TxScope } from '#libs/tenancy/index.js';

export type JobRow = Selectable<DB['core.background_jobs']>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobResultType =
  | 'ai_insight'
  | 'inventory_import_batch'
  | 'fleet_import_batch'
  | 'fleet_export'
  | 'data_subject_request'
  | 'pre_visit_report'
  | 'match_session'
  | 'media_asset'
  | 'taxonomy_node';

/** 40 §4.1 Job (response projection). */
export interface JobView {
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  kind: JobKind;
  status: JobStatus;
  progress?: number;
  result?: { type: JobResultType; id: string };
  error_code?: string;
  expires_at: string;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

export function toJobView(row: JobRow): JobView {
  const view: JobView = {
    id: row.id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    version: row.version,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    expires_at: iso(row.expires_at),
  };
  if (row.progress !== null) view.progress = row.progress;
  if (row.result_type && row.result_id) view.result = { type: row.result_type as JobResultType, id: row.result_id };
  if (row.error_code) view.error_code = row.error_code;
  return view;
}

/** The `202 Job` response of an ASYNC operation, with Location (40 §1.4). */
export function acceptedJob(row: JobRow): { status: 202; body: JobView; headers: Record<string, string> } {
  return { status: 202, body: toJobView(row), headers: { location: `/v1/jobs/${row.id}` } };
}

export interface CreateJob {
  kind: JobKind;
  ownerUserId: string;
  organizationId?: string | null;
  /** Owning module, e.g. "inventory". */
  owningModule: string;
  /** Non-personal summary of the input (shown to staff, kept with the job). */
  inputSummary?: Record<string, unknown>;
  /** Queue to run it on, e.g. "inventory-import". */
  queue: string;
  data?: Record<string, unknown>;
}

export class JobService {
  constructor(private readonly queue: JobQueue) {}

  /** Inserts the job in the current transaction and enqueues it after commit. */
  async create(scope: TxScope, input: CreateJob): Promise<JobRow> {
    const row = await scope.db
      .insertInto('core.background_jobs')
      .values({
        kind: input.kind,
        owner_user_id: input.ownerUserId,
        organization_id: input.organizationId ?? null,
        owning_module: input.owningModule,
        input_summary: input.inputSummary ? JSON.stringify(input.inputSummary) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const job: QueuedJob = { jobId: row.id, ...(input.data ? { data: input.data } : {}) };
    scope.afterCommit(() => this.queue.enqueue(input.queue, job));
    return row;
  }

  /** Cancels a queued or running job (jobs.cancel); 409 INVALID_TRANSITION otherwise. */
  async cancel(scope: TxScope, row: JobRow): Promise<JobRow> {
    if (row.status !== 'queued' && row.status !== 'running') throw new ApiError('INVALID_TRANSITION', { detail: `job is ${row.status}` });
    const updated = await scope.db
      .updateTable('core.background_jobs')
      .set({ status: 'cancelled', finished_at: new Date() })
      .where('id', '=', row.id)
      .where('status', 'in', ['queued', 'running'])
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ApiError('INVALID_TRANSITION', { detail: 'job finished meanwhile' });
    scope.afterCommit(() => this.queue.cancel(row.id));
    return updated;
  }
}

export interface JobContext {
  job: JobRow;
  signal: AbortSignal;
  progress(percent: number): Promise<void>;
}

export type JobOutcome = { result: { type: JobResultType; id: string } } | { errorCode: string };

/**
 * Worker side: runs queued jobs and records running → succeeded / failed in
 * core.background_jobs (system context). A cancelled job is not started; a
 * handler should check `signal` between steps.
 */
export class JobRunner {
  constructor(
    private readonly tx: TxRunner,
    private readonly queue: JobQueue,
    private readonly log?: { error(o: object, m: string): void },
  ) {}

  register(queue: string, handler: (ctx: JobContext) => Promise<JobOutcome>, concurrency = 1): () => void {
    return this.queue.process(
      queue,
      async (queued, signal) => {
        const started = Date.now();
        const job = await this.tx.run({ actorType: 'system' }, ({ db }) =>
          db
            .updateTable('core.background_jobs')
            .set({ status: 'running', started_at: new Date() })
            .where('id', '=', queued.jobId)
            .where('status', '=', 'queued')
            .returningAll()
            .executeTakeFirst(),
        );
        if (!job) return; // cancelled or already handled
        let outcome: JobOutcome;
        try {
          outcome = await handler({
            job,
            signal,
            progress: async (percent) => {
              await this.tx.run({ actorType: 'system' }, ({ db }) =>
                db
                  .updateTable('core.background_jobs')
                  .set({ progress: Math.max(0, Math.min(100, Math.round(percent))) })
                  .where('id', '=', job.id)
                  .where('status', '=', 'running')
                  .execute(),
              );
            },
          });
        } catch (err) {
          this.log?.error({ err, job_id: job.id, queue }, 'job failed');
          outcome = { errorCode: 'INTERNAL' };
        }
        await this.tx.run({ actorType: 'system' }, ({ db }) =>
          db
            .updateTable('core.background_jobs')
            .set(
              'result' in outcome
                ? {
                    status: 'succeeded',
                    progress: 100,
                    result_type: outcome.result.type,
                    result_id: outcome.result.id,
                    finished_at: new Date(),
                  }
                : { status: 'failed', error_code: outcome.errorCode, finished_at: new Date() },
            )
            .where('id', '=', job.id)
            .where('status', '=', 'running')
            .execute(),
        );
        appMetrics.jobDuration.record(Date.now() - started, { queue });
      },
      concurrency,
    );
  }
}

/**
 * A time-based rule run by the W15 scheduler (41 §6.3). Modules provide rules
 * as Nest providers; only the scheduler leader runs them, never two runs of
 * the same rule at once.
 */
export abstract class ScheduledRule {
  /** Stable name, e.g. "trust.review_path2_deadline". */
  abstract readonly name: string;
  /** Interval between runs (every 5 min, hourly, daily …). */
  abstract readonly everyMs: number;
  /** May return a summary (e.g. rows changed) for logs and tests. */
  abstract run(): Promise<unknown>;
}
