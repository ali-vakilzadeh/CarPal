// Test app factory (L22, S2.T14): boots one deployable (api, admin-api or
// auth) on an ephemeral port, connected to the local database with its real
// role, plus fixtures and a request helper. Tests can bind ad-hoc handlers to
// any contract operation and override platform providers.
import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplicationContext, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SessionStore, TokenService } from '#libs/auth/index.js';
import { loadConfig, type CarpalConfig } from '#libs/config/index.js';
import type { OperationId } from '#libs/contract/index.js';
import { Database } from '#libs/db/index.js';
import { markOverride, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { createInfra, type EmailMessage, type FileMailer, type FileSmsSender, type Infra, type SmsMessage } from '#libs/infra/index.js';
import { createLogger, type Logger } from '#libs/observability/index.js';
import { createHttpHost, type HttpHost, type HttpHostName } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { Fixtures, PrincipalFactory, send, type TestRequest, type TestResponse } from '#libs/testing/index.js';
import { adminApiAppModule, apiAppModule, authAppModule, workerAppModule, type AppOptions } from '../shared/app-modules.js';
import { nestLogger } from '../shared/bootstrap.js';

export type HandlerFn = (ctx: OperationContext) => Promise<OperationResult> | OperationResult;

/** A Nest module whose providers handle the given operations (test-only handlers; they replace real ones). */
export function handlerModule(handlers: Partial<Record<OperationId, HandlerFn>>): DynamicModule {
  const providers: Provider[] = Object.entries(handlers).map(([opId, fn]) => {
    const cls = class implements OperationHandler {
      handle(ctx: OperationContext) {
        return fn!(ctx);
      }
    };
    Object.defineProperty(cls, 'name', { value: `TestHandler_${opId.replace('.', '_')}` });
    Operation(opId as OperationId)(cls);
    markOverride(cls);
    return cls;
  });
  @Module({})
  class TestHandlersModule {}
  return { module: TestHandlersModule, providers };
}

export interface TestAppOptions {
  host: HttpHostName;
  /** Environment overrides (CARPAL_*). */
  env?: Record<string, string>;
  handlers?: Partial<Record<OperationId, HandlerFn>>;
  imports?: DynamicModule['imports'];
  providers?: Provider[];
  /** Share adapters between several apps (sessions, events). */
  infra?: Infra;
}

export interface TestApp {
  url: string;
  host: HttpHostName;
  app: INestApplicationContext;
  http: HttpHost;
  infra: Infra;
  config: CarpalConfig;
  fixtures: Fixtures;
  principals: PrincipalFactory;
  request<T = unknown>(r: TestRequest): Promise<TestResponse<T>>;
  /** Messages the lite mail and SMS sinks received (newest last). */
  mail(to: string, template?: string): EmailMessage[];
  sms(to: string): SmsMessage[];
  close(): Promise<void>;
}

export const testLogger = (config: CarpalConfig): Logger =>
  createLogger({ level: process.env.CARPAL_TEST_LOG ? 'debug' : 'silent', base: { service: 'test', env: config.env } });

export function testConfig(env: Record<string, string> = {}): CarpalConfig {
  return loadConfig({
    CARPAL_RATE_LIMIT_SCALE: '1000',
    CARPAL_VALIDATE_RESPONSES: '1',
    CARPAL_FLAG_REFRESH_MS: '0',
    // SEC-AU-11 latency floor off by default in tests (auth-server.int.test.ts measures it explicitly).
    CARPAL_AUTH_MIN_LATENCY_MS: '0',
    CARPAL_POW_DIFFICULTY_BITS: '8',
    // The shared test database holds every earlier run's organizations: tests index what they create (S6).
    CARPAL_SEARCH_REBUILD_ON_START: '0',
    ...env,
  });
}

const MODULES: Record<HttpHostName, (o: AppOptions) => DynamicModule> = {
  api: apiAppModule,
  'admin-api': adminApiAppModule,
  auth: authAppModule,
};

export async function createTestApp(o: TestAppOptions): Promise<TestApp> {
  const config = testConfig(o.env);
  const logger = testLogger(config);
  const ownsInfra = !o.infra;
  const infra = o.infra ?? createInfra(config, { dataDir: null, logger });
  const imports = [...(o.imports ?? []), ...(o.handlers ? [handlerModule(o.handlers)] : [])];
  const module = MODULES[o.host]({ config, infra, logger, imports, ...(o.providers ? { providers: o.providers } : {}) });
  const app = await NestFactory.createApplicationContext(module, { logger: nestLogger(logger), abortOnError: false });
  const http = createHttpHost(app, o.host);
  const address = await http.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const fixtureDb = new Database(config, 'carpal_worker', { max: 3, applicationName: 'carpal-test-fixtures' });
  const fixtures = new Fixtures(
    new TxRunner(fixtureDb),
    app.get(TokenService, { strict: false }),
    app.get(SessionStore, { strict: false }),
    config,
  );
  return {
    url,
    host: o.host,
    app,
    http,
    infra,
    config,
    fixtures,
    principals: new PrincipalFactory(fixtures),
    request: (r) => send(url, r),
    mail: (to, template) => (infra.mailer as FileMailer).sent.filter((m) => m.to === to && (!template || m.template === template)),
    sms: (to) => (infra.sms as FileSmsSender).sent.filter((m) => m.to === to),
    async close() {
      await http.close();
      await app.close();
      await fixtureDb.close();
      if (ownsInfra) await infra.close();
    },
  };
}

/** Boots the worker deployable (outbox relay, consumers, scheduler) on shared adapters. */
export async function createTestWorker(o: {
  infra: Infra;
  env?: Record<string, string>;
  imports?: DynamicModule['imports'];
}): Promise<INestApplicationContext> {
  const config = testConfig({ CARPAL_OUTBOX_POLL_MS: '100', ...o.env });
  const logger = testLogger(config);
  const app = await NestFactory.createApplicationContext(
    workerAppModule({ config, infra: o.infra, logger, ...(o.imports ? { imports: o.imports } : {}) }),
    {
      logger: nestLogger(logger),
      abortOnError: false,
    },
  );
  await app.init();
  return app;
}
