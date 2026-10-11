import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { MemoryKeyValueStore, type Infra } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { createLogger } from '#libs/observability/index.js';
import { LEADER_KEY, SchedulerService } from './scheduler.service.js';

class CountingRule extends ScheduledRule {
  readonly name = 'test.counting';
  readonly everyMs = 60_000;
  runs = 0;
  async run(): Promise<void> {
    this.runs++;
  }
}

const logger = createLogger({ level: 'silent' });

function scheduler(kv: MemoryKeyValueStore, rule: ScheduledRule): SchedulerService {
  const discovery = { getProviders: () => [{ instance: rule }] } as unknown as DiscoveryService;
  const s = new SchedulerService(discovery, { kv } as unknown as Infra, logger);
  s.rules.push(rule);
  return s;
}

describe('W15 scheduler', () => {
  it('runs rules on one leader only, on their interval, and hands over when the leader goes away', async () => {
    let now = 1_000_000;
    const kv = new MemoryKeyValueStore(() => now);
    const ruleA = new CountingRule();
    const ruleB = new CountingRule();
    const a = scheduler(kv, ruleA);
    const b = scheduler(kv, ruleB);

    await a.tick(now);
    await b.tick(now);
    await a.settle();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    expect([ruleA.runs, ruleB.runs]).toEqual([1, 0]);

    now += 30_000;
    await a.tick(now); // renews the lock; not due yet
    expect(ruleA.runs).toBe(1);
    now += 30_001;
    await a.tick(now);
    await a.settle();
    expect(ruleA.runs).toBe(2);

    // Leader stops cleanly: the lock is released and the other instance takes over.
    await a.onApplicationShutdown();
    expect(await kv.get(LEADER_KEY)).toBeNull();
    await b.tick(now);
    await b.settle();
    expect(b.isLeader).toBe(true);
    expect(ruleB.runs).toBe(1);
    await b.onApplicationShutdown();
  });
});
