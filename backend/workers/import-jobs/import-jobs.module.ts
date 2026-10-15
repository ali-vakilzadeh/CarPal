// W7 import-jobs (41 §2.4) in the worker deployable: inventory CSV imports
// (queue inventory.import, inventory.import_create) and bulk updates (queue
// inventory.bulk_update, inventory.bulk_update), both through JobRunner so
// core.background_jobs records running → succeeded / failed. S8 adds fleet
// vehicle imports (queue fleet.import) and taxonomy merges (queue
// taxonomy.merge: re-pointing every module's references after approval).
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { JobRunner } from '#libs/jobs/index.js';
import { FLEET_IMPORT_QUEUE, FleetImporter, FleetWorkerModule } from '#modules/fleet/fleet.module.js';
import { BULK_QUEUE, IMPORT_QUEUE, InventoryBulkUpdater, InventoryImporter } from '#modules/inventory/inventory.module.js';
import { TAXONOMY_MERGE_QUEUE, TaxonomyMerger } from '#modules/taxonomy/taxonomy.module.js';

@Injectable()
export class ImportJobsHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #stop: (() => void)[] = [];

  constructor(
    private readonly runner: JobRunner,
    private readonly importer: InventoryImporter,
    private readonly bulk: InventoryBulkUpdater,
    private readonly merger: TaxonomyMerger,
    private readonly fleet: FleetImporter,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop.push(this.runner.register(IMPORT_QUEUE, (ctx) => this.importer.run(ctx)));
    this.#stop.push(this.runner.register(BULK_QUEUE, (ctx) => this.bulk.run(ctx)));
    this.#stop.push(this.runner.register(TAXONOMY_MERGE_QUEUE, (ctx) => this.merger.run(ctx)));
    this.#stop.push(this.runner.register(FLEET_IMPORT_QUEUE, (ctx) => this.fleet.run(ctx)));
  }

  onApplicationShutdown(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}

@Module({ imports: [FleetWorkerModule], providers: [ImportJobsHost] })
export class ImportJobsModule {}
