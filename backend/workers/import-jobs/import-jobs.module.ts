// W7 import-jobs (41 §2.4) in the worker deployable: inventory CSV imports
// (queue inventory.import, inventory.import_create) and bulk updates (queue
// inventory.bulk_update, inventory.bulk_update), both through JobRunner so
// core.background_jobs records running → succeeded / failed. Fleet imports
// join here in S8.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { JobRunner } from '#libs/jobs/index.js';
import { BULK_QUEUE, IMPORT_QUEUE, InventoryBulkUpdater, InventoryImporter } from '#modules/inventory/inventory.module.js';

@Injectable()
export class ImportJobsHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #stop: (() => void)[] = [];

  constructor(
    private readonly runner: JobRunner,
    private readonly importer: InventoryImporter,
    private readonly bulk: InventoryBulkUpdater,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop.push(this.runner.register(IMPORT_QUEUE, (ctx) => this.importer.run(ctx)));
    this.#stop.push(this.runner.register(BULK_QUEUE, (ctx) => this.bulk.run(ctx)));
  }

  onApplicationShutdown(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}

@Module({ providers: [ImportJobsHost] })
export class ImportJobsModule {}
