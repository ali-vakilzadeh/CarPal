// W15 scheduler (41 §2.4, §6.3): one leader per deployment, chosen with a lock
// in the KV store (renewed while alive, taken over when it expires). The
// leader runs every ScheduledRule provider on its interval; a rule never runs
// twice at the same time, and a failing rule does not stop the others.
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { uuidv7 } from '#libs/crypto/index.js';
import type { Infra } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectInfra, InjectLogger } from '#libs/runtime/index.js';

export const LEADER_KEY = 'scheduler:leader';
const LEADER_TTL_MS = 30_000;
const TICK_MS = 5_000;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly instanceId = uuidv7();
  readonly rules: ScheduledRule[] = [];
  readonly #lastRun = new Map<string, number>();
  readonly #running = new Map<string, Promise<unknown>>();
  #timer: NodeJS.Timeout | null = null;
  #leader = false;

  constructor(
    private readonly discovery: DiscoveryService,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  get isLeader(): boolean {
    return this.#leader;
  }

  onApplicationBootstrap(): void {
    for (const w of this.discovery.getProviders()) if (w.instance instanceof ScheduledRule) this.rules.push(w.instance);
    this.logger.info({ rules: this.rules.map((r) => r.name), instance: this.instanceId }, 'scheduler started');
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    this.#timer.unref();
    void this.tick();
  }

  /** Renews or takes the leader lock, then starts the due rules when leader. */
  async tick(now = Date.now()): Promise<void> {
    const kv = this.infra.kv;
    const holder = await kv.get(LEADER_KEY);
    if (holder === this.instanceId) await kv.set(LEADER_KEY, this.instanceId, { ttlMs: LEADER_TTL_MS, mode: 'XX' });
    else if (holder === null) await kv.set(LEADER_KEY, this.instanceId, { ttlMs: LEADER_TTL_MS, mode: 'NX' });
    const leader = (await kv.get(LEADER_KEY)) === this.instanceId;
    if (leader !== this.#leader)
      this.logger.info({ instance: this.instanceId, leader }, leader ? 'scheduler leadership acquired' : 'scheduler leadership lost');
    this.#leader = leader;
    if (!leader) return;
    for (const rule of this.rules) {
      const last = this.#lastRun.get(rule.name);
      if (this.#running.has(rule.name) || (last !== undefined && now - last < rule.everyMs)) continue;
      this.#lastRun.set(rule.name, now);
      const run = rule
        .run()
        .catch((err: unknown) => this.logger.error({ err, rule: rule.name }, 'scheduled rule failed'))
        .finally(() => this.#running.delete(rule.name));
      this.#running.set(rule.name, run);
    }
  }

  /** Resolves when no rule is running (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.settle();
    if (this.#leader) await this.infra.kv.compareAndDelete(LEADER_KEY, this.instanceId);
    this.#leader = false;
  }
}
