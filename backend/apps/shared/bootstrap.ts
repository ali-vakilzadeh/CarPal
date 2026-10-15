// Starts deployables: a Nest application context per host plus, for HTTP
// hosts, the contract pipeline on node:http. Used by each apps/<host>/main.ts
// and by apps/dev (all hosts in one lite-mode process).
import 'reflect-metadata';
import type { DynamicModule, INestApplicationContext, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { CarpalConfig } from '#libs/config/index.js';
import type { Logger } from '#libs/observability/index.js';
import { createHttpHost, type HttpHost, type HttpHostName } from '#libs/runtime/index.js';

/** Routes Nest's own messages (module init, DI errors) into the structured log. */
export function nestLogger(logger: Logger): LoggerService {
  const child = logger.child({ component: 'nest' });
  return {
    log: () => {},
    debug: () => {},
    verbose: () => {},
    warn: (message: unknown) => child.warn({ nest: String(message) }, 'nest warning'),
    error: (message: unknown, trace?: unknown) =>
      child.error({ nest: String(message), trace: typeof trace === 'string' ? trace : undefined }, 'nest error'),
    fatal: (message: unknown) => child.fatal({ nest: String(message) }, 'nest fatal'),
  };
}

export interface RunningHttpApp {
  app: INestApplicationContext;
  http: HttpHost;
  url: string;
  close(): Promise<void>;
}

export async function startHttpApp(
  host: HttpHostName,
  module: DynamicModule,
  port: number,
  config: CarpalConfig,
  logger: Logger,
): Promise<RunningHttpApp> {
  const app = await NestFactory.createApplicationContext(module, { logger: nestLogger(logger), abortOnError: false });
  const http = createHttpHost(app, host);
  const address = await http.listen(port, config.http.bind);
  const url = `http://${address.address}:${address.port}`;
  logger.info({ host, url, routes: http.routes.entries.length, implemented: http.implemented.size }, 'host listening');
  return {
    app,
    http,
    url,
    async close() {
      await http.close();
      await app.close();
    },
  };
}

export async function startWorkerApp(module: DynamicModule, logger: Logger): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(module, { logger: nestLogger(logger), abortOnError: false });
  await app.init();
  logger.info({ host: 'worker' }, 'worker started');
  return app;
}

/** Deviations that are active in this process (logged once at startup, GD-06). */
export function logDeviations(config: CarpalConfig, logger: Logger): void {
  if (!config.strictAuth)
    logger.warn({ deviation: 'GD-06' }, 'CARPAL_STRICT_AUTH=0: DPoP, mTLS binding, app attestation and PoW are not enforced');
  if (config.infra === 'lite')
    logger.warn(
      { deviation: 'GD-04' },
      'lite infrastructure: in-process KV, event bus and queue; run all deployables in one process (pnpm dev)',
    );
  logger.warn({ deviation: 'GD-05' }, 'operations without a handler answer 501 NOT_IMPLEMENTED');
  if (config.mcp.mode === 'stub')
    logger.warn({ deviation: 'GD-35' }, 'CARPAL_MCP_MODE=stub: AI tools return deterministic stub results (no MCP gateway, no model)');
}

/** Stops on SIGINT/SIGTERM. */
export function onShutdown(fn: () => Promise<void>, logger: Logger): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    fn()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
