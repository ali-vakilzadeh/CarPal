// W1 outbox relay (41 §2.4): runs libs/outbox OutboxRelay in the worker
// deployable (carpal_worker, system context) for the life of the process.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { Database } from '#libs/db/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { OutboxRelay } from '#libs/outbox/index.js';
import { InjectConfig, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly relay: OutboxRelay;

  constructor(
    tx: TxRunner,
    database: Database,
    @InjectInfra() infra: Infra,
    @InjectConfig() config: CarpalConfig,
    @InjectLogger() logger: Logger,
  ) {
    this.relay = new OutboxRelay({
      tx,
      database,
      bus: infra.bus,
      pollMs: config.pipeline.outboxPollMs,
      log: logger.child({ worker: 'outbox-relay' }),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
  }
}

@Module({ providers: [OutboxRelayService], exports: [OutboxRelayService] })
export class OutboxRelayModule {}
