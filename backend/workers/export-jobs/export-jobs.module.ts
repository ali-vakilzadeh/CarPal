// W8 export-jobs (41 §2.4) in the worker deployable: fleet CSV exports (queue
// fleet.export, fleet.export_create) and DSR export bundles (queue
// identity.dsr_export, admin.dsr_export), both through JobRunner so
// core.background_jobs records running → succeeded / failed. Files are
// formula-safe CSV (SEC-IN-11), private and encrypted (system_export).
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { JobRunner } from '#libs/jobs/index.js';
import { FLEET_EXPORT_QUEUE, FleetExporter, FleetWorkerModule } from '#modules/fleet/fleet.module.js';
import { DSR_EXPORT_QUEUE, DsrExporter, IdentityWorkerModule } from '#modules/identity/identity.module.js';

@Injectable()
export class ExportJobsHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #stop: (() => void)[] = [];

  constructor(
    private readonly runner: JobRunner,
    private readonly fleet: FleetExporter,
    private readonly dsr: DsrExporter,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop.push(this.runner.register(FLEET_EXPORT_QUEUE, (ctx) => this.fleet.run(ctx)));
    this.#stop.push(this.runner.register(DSR_EXPORT_QUEUE, (ctx) => this.dsr.run(ctx)));
  }

  onApplicationShutdown(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}

@Module({ imports: [FleetWorkerModule, IdentityWorkerModule], providers: [ExportJobsHost] })
export class ExportJobsModule {}
