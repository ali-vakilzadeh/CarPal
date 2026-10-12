// W6 media-processor (41 §2.4) in the worker deployable: runs the media
// module's MediaProcessor for uploads completed by media.upload_complete
// (queue media.process) and for redaction jobs (media.redaction), plus two
// W15 rules: re-queue assets whose scan entry was lost (lite queues live in
// one process) and discard uploads that were never completed.
import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import type { Infra } from '#libs/infra/index.js';
import { JobRunner, ScheduledRule } from '#libs/jobs/index.js';
import { CARPAL_CONFIG, InjectInfra } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { MEDIA_PROCESS_QUEUE, MEDIA_REDACTION_QUEUE, MediaProcessor, pendingScans } from '#modules/media/media.module.js';

@Injectable()
export class MediaProcessorHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #stop: (() => void)[] = [];

  constructor(
    private readonly processor: MediaProcessor,
    private readonly runner: JobRunner,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop.push(this.infra.jobs.process(MEDIA_PROCESS_QUEUE, (job) => this.processor.process(job.jobId), 2));
    this.#stop.push(this.runner.register(MEDIA_REDACTION_QUEUE, (ctx) => this.processor.redact(ctx)));
  }

  onApplicationShutdown(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}

/** Assets still waiting for a scan after CARPAL_MEDIA_RESCAN_AFTER_MS are queued again (processing is idempotent). */
@Injectable()
export class MediaRescanRule extends ScheduledRule {
  readonly name = 'media.rescan_pending';
  readonly everyMs = 60_000;

  constructor(
    private readonly tx: TxRunner,
    @InjectInfra() private readonly infra: Infra,
    @Inject(CARPAL_CONFIG) private readonly config: CarpalConfig,
  ) {
    super();
  }

  async run(): Promise<number> {
    const ids = await this.tx.run({ actorType: 'system' }, (scope) => pendingScans(scope, this.config.media.rescanAfterMs));
    for (const id of ids) await this.infra.jobs.enqueue(MEDIA_PROCESS_QUEUE, { jobId: id });
    return ids.length;
  }
}

/** 52 MediaAsset.upload_expires_at: a pending_upload asset past its window is discarded with its object. */
@Injectable()
export class MediaExpiredUploadsRule extends ScheduledRule {
  readonly name = 'media.discard_expired_uploads';
  readonly everyMs = 10 * 60_000;

  constructor(
    private readonly tx: TxRunner,
    @InjectInfra() private readonly infra: Infra,
  ) {
    super();
  }

  async run(): Promise<number> {
    const rows = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('media.media_assets')
        .set({ status: 'removed' })
        .where('status', '=', 'pending_upload')
        .where('upload_expires_at', '<', sql<Date>`now() - interval '1 hour'`)
        .returning(['id', 'storage_reference'])
        .execute(),
    );
    for (const r of rows) if (r.storage_reference) await this.infra.storage.delete(r.storage_reference);
    return rows.length;
  }
}

@Module({ providers: [MediaProcessorHost, MediaRescanRule, MediaExpiredUploadsRule] })
export class MediaProcessorModule {}
