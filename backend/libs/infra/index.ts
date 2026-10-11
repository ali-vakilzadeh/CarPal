// Infrastructure ports and adapters (GD-04, S2.T2). createInfra() builds the
// adapter set chosen by CARPAL_INFRA once per process.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CarpalConfig } from '#libs/config/index.js';
import { KeyRing } from '#libs/crypto/index.js';
import * as full from './full/skeletons.js';
import { LocalObjectStorage, objectsDir } from './lite/local-storage.js';
import { MemoryEventBus, type BusLogger } from './lite/memory-bus.js';
import { MemoryKeyValueStore } from './lite/memory-kv.js';
import { MemoryJobQueue } from './lite/memory-queue.js';
import { FileDeadLetterStore, FileMailer, FilePushSender, FileSmsSender } from './lite/sinks.js';
import type { Infra, SearchIndex } from './ports.js';

export type * from './ports.js';
export { MemoryKeyValueStore } from './lite/memory-kv.js';
export { MemoryEventBus, subjectMatches } from './lite/memory-bus.js';
export { MemoryJobQueue } from './lite/memory-queue.js';
export { LocalObjectStorage } from './lite/local-storage.js';
export { FileDeadLetterStore, FileMailer, FilePushSender, FileSmsSender } from './lite/sinks.js';
export { NotConfiguredError } from './full/skeletons.js';

export interface InfraOptions {
  /** Where lite adapters keep files; null keeps everything in memory (tests). */
  dataDir: string | null;
  logger?: BusLogger;
}

/** Search is implemented in S6; lite mode answers empty until then. */
const unimplementedSearch: SearchIndex = {
  upsert: () => Promise.reject(new Error('SearchIndex is implemented in S6')),
  remove: () => Promise.reject(new Error('SearchIndex is implemented in S6')),
  search: () => Promise.reject(new Error('SearchIndex is implemented in S6')),
  count: () => Promise.reject(new Error('SearchIndex is implemented in S6')),
};

export function createInfra(config: CarpalConfig, options: InfraOptions): Infra {
  if (config.infra === 'full') {
    const s = config.services;
    return {
      mode: 'full',
      kv: full.redisKeyValueStore(s.redisUrl),
      bus: full.natsEventBus(s.natsUrl),
      deadLetters: full.natsDeadLetters(s.natsUrl),
      jobs: full.bullJobQueue(s.redisUrl),
      storage: full.s3ObjectStorage(s.s3Endpoint),
      search: full.openSearchIndex(s.searchUrl),
      mailer: full.smtpMailer(s.smtpUrl),
      sms: full.smsGateway('sms'),
      push: full.pushGateway('push'),
      close: () => Promise.resolve(),
    };
  }
  const dir = options.dataDir;
  const deadLetters = new FileDeadLetterStore(dir);
  const kv = new MemoryKeyValueStore();
  const bus = new MemoryEventBus(deadLetters, options.logger);
  const jobs = new MemoryJobQueue(options.logger);
  const storage = new LocalObjectStorage(
    dir ? objectsDir(dir) : join(tmpdir(), `carpal-objects-${process.pid}`),
    config.http.mediaBaseUrl,
    new KeyRing(config.secrets.master).hmacKey('storage-url'),
  );
  return {
    mode: 'lite',
    kv,
    bus,
    deadLetters,
    jobs,
    storage,
    search: unimplementedSearch,
    mailer: new FileMailer(dir),
    sms: new FileSmsSender(dir),
    push: new FilePushSender(dir),
    async close() {
      await bus.close();
      await jobs.close();
      await kv.close();
    },
  };
}
