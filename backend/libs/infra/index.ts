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
import { FileDeadLetterStore, FileMailer, FilePushSender } from './lite/sinks.js';
import { MemorySearchIndex } from './lite/memory-search.js';
import { createSmsGateway } from '#libs/sms/index.js';
import { GatewaySmsSender } from './sms-sender.js';
import { SmtpMailer } from './smtp-mailer.js';
import type { Infra, KeyValueStore, Mailer } from './ports.js';

export type * from './ports.js';
export { MemoryKeyValueStore } from './lite/memory-kv.js';
export { MemoryEventBus, subjectMatches } from './lite/memory-bus.js';
export { MemoryJobQueue } from './lite/memory-queue.js';
export { MemorySearchIndex, matchesFilter, tokenMatch, withinOneEdit } from './lite/memory-search.js';
export { LocalObjectStorage } from './lite/local-storage.js';
export { FileDeadLetterStore, FileMailer, FilePushSender, FileSmsSender } from './lite/sinks.js';
export { NotConfiguredError } from './full/skeletons.js';
export { SendError } from './ports.js';
export { SmtpMailer, addressOf, classify as classifySmtpError, type SmtpMailerOptions } from './smtp-mailer.js';
export { GatewaySmsSender } from './sms-sender.js';

export interface InfraOptions {
  /** Where lite adapters keep files; null keeps everything in memory (tests). */
  dataDir: string | null;
  logger?: BusLogger;
  /** Region SMS country codes for the gateway's E.164 check (callers also check them, SEC-AU-8). */
  smsCountryCodes?: readonly string[];
}

/** CARPAL_MAIL_TRANSPORT (S26a.T2): the file sink, or SMTP submission to the mailbox. */
function mailerFor(config: CarpalConfig, dir: string | null, kv: KeyValueStore, logger?: BusLogger): Mailer {
  if (config.mail.transport === 'file') return new FileMailer(dir);
  return new SmtpMailer({
    url: config.services.smtpUrl,
    from: config.mail.from,
    replyTo: config.mail.replyTo,
    maxPerHour: config.mail.maxPerHour,
    env: config.env,
    tlsInsecure: config.mail.tlsInsecure,
    kv,
    ...(logger ? { logger: { warn: (o, m) => logger.warn(o, m), error: (o, m) => logger.error(o, m) } } : {}),
  });
}

export function createInfra(config: CarpalConfig, options: InfraOptions): Infra {
  if (config.infra === 'full') {
    const s = config.services;
    const kv = full.redisKeyValueStore(s.redisUrl);
    const gateway = createSmsGateway(config, {
      dataDir: null,
      ...(options.smsCountryCodes ? { countryCodes: options.smsCountryCodes } : {}),
    });
    const mailer = mailerFor(config, null, kv, options.logger);
    return {
      mode: 'full',
      kv,
      bus: full.natsEventBus(s.natsUrl),
      deadLetters: full.natsDeadLetters(s.natsUrl),
      jobs: full.bullJobQueue(s.redisUrl),
      storage: full.s3ObjectStorage(s.s3Endpoint),
      search: full.openSearchIndex(s.searchUrl),
      mailer,
      sms: new GatewaySmsSender(gateway, config.sms.otpTemplate),
      smsGateway: gateway,
      push: full.pushGateway('push'),
      close: () => {
        if (mailer instanceof SmtpMailer) mailer.close();
        return Promise.resolve();
      },
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
    Date.now,
    new KeyRing(config.secrets.master).derive('storage-sse'),
    config.media.corsOrigins,
  );
  const gateway = createSmsGateway(config, { dataDir: dir, ...(options.smsCountryCodes ? { countryCodes: options.smsCountryCodes } : {}) });
  const mailer = mailerFor(config, dir, kv, options.logger);
  return {
    mode: 'lite',
    kv,
    bus,
    deadLetters,
    jobs,
    storage,
    search: new MemorySearchIndex(),
    mailer,
    sms: new GatewaySmsSender(gateway, config.sms.otpTemplate),
    smsGateway: gateway,
    push: new FilePushSender(dir),
    async close() {
      if (mailer instanceof SmtpMailer) mailer.close();
      await bus.close();
      await jobs.close();
      await kv.close();
    },
  };
}
