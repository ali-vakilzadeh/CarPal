// Consumer registry of the worker deployable (41 §6.2): every provider that
// extends EventConsumer (libs/outbox) is subscribed to the event bus, with
// de-duplication on event_id, when the application starts.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { EventConsumer, registerConsumer } from '#libs/outbox/index.js';
import { InjectInfra, InjectLogger } from '#libs/runtime/index.js';

@Injectable()
export class ConsumerRegistry implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #unsubscribe: (() => void)[] = [];
  readonly names: string[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    for (const w of this.discovery.getProviders()) {
      if (!(w.instance instanceof EventConsumer)) continue;
      const consumer = w.instance;
      if (this.names.includes(consumer.name)) throw new Error(`duplicate consumer name ${consumer.name}`);
      this.#unsubscribe.push(registerConsumer(this.infra.bus, this.infra.kv, consumer, this.logger));
      this.names.push(consumer.name);
    }
    this.logger.info({ consumers: this.names }, 'event consumers registered');
  }

  onApplicationShutdown(): void {
    for (const u of this.#unsubscribe.splice(0)) u();
  }
}

@Module({ providers: [ConsumerRegistry], exports: [ConsumerRegistry] })
export class ConsumerHostModule {}
