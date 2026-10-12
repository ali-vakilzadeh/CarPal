// Mounts the contract pipeline of one host on node:http. Handlers are the
// providers of the Nest context decorated with @Operation(opId); routes come
// only from operations.json (GD-05: an operation without a handler answers
// 501). Nest supplies dependency injection, modules and lifecycle; there are
// no Nest controllers, so no route can exist outside the contract (SEC-AZ-1).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Authenticator } from '#libs/auth/index.js';
import { Authorizer } from '#libs/authz/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { loadRegistry } from '#libs/contract/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { FlagService } from '#libs/flags/index.js';
import {
  ContractValidator,
  HttpPipeline,
  isOverride,
  NodeTypeChecker,
  operationIdsOf,
  RouteTable,
  type OperationHandler,
} from '#libs/http-pipeline/index.js';
import { IdempotencyStore } from '#libs/idempotency/index.js';
import type { Logger } from '#libs/observability/index.js';
import { LoadShedder, RateLimiter } from '#libs/rate-limit/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { CARPAL_CONFIG, LOGGER } from './tokens.js';

export type HttpHostName = 'api' | 'admin-api' | 'auth';

export interface HttpHost {
  readonly host: HttpHostName;
  readonly pipeline: HttpPipeline;
  readonly server: Server;
  readonly routes: RouteTable;
  /** Op ids with a bound handler on this host. */
  readonly implemented: ReadonlySet<string>;
  listen(port: number, bind: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

/** Collects @Operation handlers of the context, keyed by op id. */
export function discoverHandlers(app: INestApplicationContext, host: HttpHostName): Map<string, OperationHandler> {
  const discovery = app.get(DiscoveryService, { strict: false });
  const known = new Map(loadRegistry().operations.map((o) => [o.opId, o]));
  const handlers = new Map<string, OperationHandler>();
  const overridden = new Set<string>();
  for (const wrapper of discovery.getProviders()) {
    const opIds = operationIdsOf(wrapper.metatype);
    if (!opIds || !wrapper.instance) continue;
    const override = isOverride(wrapper.metatype);
    for (const opId of opIds) {
      const op = known.get(opId);
      if (!op) throw new Error(`@Operation('${opId}') on ${wrapper.name}: not an operation of the contract`);
      if (!op.routes.some((r) => r.host === host)) continue; // served by another deployable
      const instance = wrapper.instance as OperationHandler;
      if (typeof instance.handle !== 'function') throw new Error(`${wrapper.name} has no handle() method`);
      // A test override replaces the real handler; two real handlers for one operation are a defect.
      if (overridden.has(opId)) continue;
      if (handlers.has(opId) && !override) throw new Error(`two handlers for ${opId}`);
      handlers.set(opId, instance);
      if (override) overridden.add(opId);
    }
  }
  return handlers;
}

/** An optional provider of the context (ports owned by domain modules). */
function optional<T>(app: INestApplicationContext, token: abstract new (...args: never[]) => T): T | undefined {
  try {
    return app.get(token, { strict: false });
  } catch {
    return undefined;
  }
}

export function createHttpHost(app: INestApplicationContext, host: HttpHostName): HttpHost {
  const config = app.get<CarpalConfig>(CARPAL_CONFIG, { strict: false });
  const logger = app.get<Logger>(LOGGER, { strict: false });
  const routes = new RouteTable(host);
  const handlers = discoverHandlers(app, host);
  const nodeTypes = optional(app, NodeTypeChecker);
  const pipeline = new HttpPipeline({
    host,
    config,
    routes,
    handlers,
    validator: app.get(ContractValidator, { strict: false }),
    authenticator: app.get(Authenticator, { strict: false }),
    authorizer: app.get(Authorizer, { strict: false }),
    rateLimiter: app.get(RateLimiter, { strict: false }),
    shedder: app.get(LoadShedder, { strict: false }),
    flags: app.get(FlagService, { strict: false }),
    idempotency: app.get(IdempotencyStore, { strict: false }),
    tx: app.get(TxRunner, { strict: false }),
    crypto: app.get(CryptoServices, { strict: false }),
    logger,
    locales: app.get(RegionConfigService, { strict: false }).locales,
    ...(nodeTypes ? { nodeTypes } : {}),
  });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 20_000, keepAliveTimeout: 5_000 }, pipeline.listener);
  return {
    host,
    pipeline,
    server,
    routes,
    implemented: new Set(handlers.keys()),
    listen: (port, bind) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => resolve(server.address() as AddressInfo));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}
