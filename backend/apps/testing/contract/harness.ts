// Contract sweep harness (S9b, 40 Appendix C, 41 §8): one set of adapters
// shared by the four hosts the sweep calls — the api host with the AI kill
// switch on (every non-AI operation must succeed there), the api host with AI
// on (AI operations and setup), admin-api and auth — plus a worker (W6 media
// processing, AI jobs, consumers) and the storage listener. Resolvers build
// their fixtures through it and describe the call to make (a Case); the
// runner (runner.ts) derives the generic checks from the registry.
import type { INestApplicationContext } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { OrgType } from '#libs/contract/generated/enums.js';
import type { Route } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { FlagService, type FlagContext } from '#libs/flags/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { jpegWithExif, TEST_CLIENT, tinyPdf, type TestOrg, type TestResponse, type TestUser } from '#libs/testing/index.js';
import { MediaHarness, taxonomyNodes, type Json, type Nodes } from '../s4-support.js';
import { flush, publishedProvider, publishedVendor, uniquePoint, type PublishedOrg } from '../s6-support.js';
import { ADMIN_CLIENT } from '../s8-support.js';
import { createTestApp, testConfig, testLogger, type TestApp } from '../test-app.js';

export type { Json, Nodes };

/** Should-have flags the sweep switches on (seeded off): their operations are part of the contract. */
export const SWEEP_FLAGS_ON = ['community.comments.enabled', 'community.feed.enabled', 'qna.enabled'];

const isAiFlag = async (flags: FlagService, key: string) => (await flags.type(key)) === 'ai_feature' || key.startsWith('ai.');

/** Seeded flags, the sweep's Should-have flags on, and (kill) every AI feature off: the kill switch (SEC-AI-6). */
function sweepFlags(kill: boolean): Provider {
  return {
    provide: FlagService,
    useFactory: (tx: TxRunner) =>
      new (class extends FlagService {
        override async isEnabled(key: string, ctx?: FlagContext): Promise<boolean> {
          if (kill && (await isAiFlag(this, key))) return false;
          if (SWEEP_FLAGS_ON.includes(key)) return true;
          return super.isEnabled(key, ctx);
        }
      })(tx, 'dev', 0),
    inject: [TxRunner],
  };
}

/** JSON client of one caller (IDEM keys on POST/PUT, If-Match from a version). */
export interface Api {
  get(path: string, headers?: Record<string, string>): Promise<TestResponse<Json>>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse<Json>>;
  put(path: string, body: unknown, headers?: Record<string, string>): Promise<TestResponse<Json>>;
  patch(path: string, body: unknown, version: number, headers?: Record<string, string>): Promise<TestResponse<Json>>;
  del(path: string, headers?: Record<string, string>): Promise<TestResponse<Json>>;
}

export function api(app: TestApp, token: string, clientHeader: string): Api {
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request<Json>({ method, path, token, client: clientHeader, headers, ...(body !== undefined ? { body } : {}) });
  return {
    get: (path, headers = {}) => req('GET', path, undefined, headers),
    post: (path, body, headers = {}) => req('POST', path, body, { 'idempotency-key': uuidv7(), ...headers }),
    put: (path, body, headers = {}) => req('PUT', path, body, { 'idempotency-key': uuidv7(), ...headers }),
    patch: (path, body, version, headers = {}) => req('PATCH', path, body, { 'if-match': `"v${version}"`, ...headers }),
    del: (path, headers = {}) => req('DELETE', path, undefined, headers),
  };
}

export interface Actor {
  kind: 'user' | 'member' | 'staff';
  user: TestUser;
  token: string;
  /** CarPal-Client header matching the token's client. */
  client: string;
  org?: TestOrg;
  role?: string;
  /** Setup client: the api host with AI on (users, members) or admin-api (staff). */
  c: Api;
}

export type Caller = Actor | { kind: 'none' } | { kind: 'anonymous'; token: string; client: string };

/** Attackers of the BOLA matrix and what they must get. */
export interface BolaSpec {
  attackers: Caller[];
  /** Path parameter overrides for the attackers (default: the owner's, org_id swapped to the attacker's organization). */
  params?: Record<string, string>;
  body?: unknown;
  /** Query for the attackers instead of the owner's (signed cursors are bound to their caller). */
  query?: Record<string, string>;
  /** Accepted statuses (default 404 NOT_FOUND or 422 REFERENCE_NOT_FOUND). */
  expect?: number[];
  /** With expect: the exact code of the refusal (its body must carry no data beyond the Problem base). */
  code?: string;
  /**
   * With expect (no existence oracle): the attackers' call about a record that does not exist must be
   * answered exactly like the call about the foreign record; a string says why it may differ.
   */
  absent?: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } | string;
}

/** One call the sweep makes as the owner of a resource, and the checks around it. */
export interface Case {
  as: Caller;
  /** Path parameters (org_id defaults to the caller's organization). */
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | string[]>;
  /** JSON body; for form-encoded operations a Record<string,string> sent as a form. */
  body?: unknown;
  headers?: Record<string, string>;
  /** CarPal-Client of the owner's calls (null omits it: browser routes of the auth host). */
  client?: string | null;
  /** If-Match "v<version>". */
  version?: number;
  /** Expected status (default: the operation's success status). */
  status?: number;
  /**
   * BOLA: 'auto' (default) derives the attacker from the route (a member of
   * another organization with the same role on organization routes, another
   * user elsewhere); a string skips it with that reason.
   */
  bola?: 'auto' | string | BolaSpec;
  /** false skips the same-organization BFLA check (the resolver checks the roles itself). */
  bfla?: false;
  /** Skips the fleet-driver check of {flt} vehicle and appointment routes, with the reason. */
  driver?: string;
  /** The body references the owner's records (SEC-AZ-4): attackers send the same body. */
  bodyRefs?: boolean;
  /** Skip the generic unknown-field / unknown-query checks, with the reason. */
  negatives?: string;
  /** price_trade may carry a value in this response (approved trade account). */
  trade?: boolean;
  check?: (res: TestResponse<Json>) => unknown;
}

export interface Skip {
  skip: string;
}

export type Resolver = (h: Harness, route: Route) => Promise<Case | Skip>;
export type Resolvers = Record<string, Resolver>;

export const skip = (reason: string): Skip => ({ skip: reason });

/** BolaSpec.absent of link-token operations (SEC-LT): an unknown token is 410 LINK_EXPIRED, a valid one 403 LINK_RECIPIENT_MISMATCH. */
export const LINK_SECRET = 'a valid link token is a 256-bit secret: its holder learns only that it is valid, never whose it is';

export class Harness {
  readonly vins = new Set<string>();
  readonly #once = new Map<string, Promise<unknown>>();
  readonly #cleanups: (() => Promise<unknown>)[] = [];

  private constructor(
    readonly infra: Infra,
    /** api host, AI on (AI operations and setup calls). */
    readonly api: TestApp,
    /** api host with the AI kill switch on: every non-AI operation of the sweep runs here. */
    readonly apiKill: TestApp,
    readonly admin: TestApp,
    readonly auth: TestApp,
    readonly media: MediaHarness,
    readonly n: Nodes,
  ) {}

  static async start(): Promise<Harness> {
    const config = testConfig();
    const infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    const api = await createTestApp({ host: 'api', infra, providers: [sweepFlags(false)] });
    const apiKill = await createTestApp({ host: 'api', infra, providers: [sweepFlags(true)] });
    const admin = await createTestApp({ host: 'admin-api', infra, providers: [sweepFlags(false)] });
    const auth = await createTestApp({ host: 'auth', infra });
    const media = await MediaHarness.start(api);
    return new Harness(infra, api, apiKill, admin, auth, media, await taxonomyNodes(api));
  }

  /** Runs at close, newest first: rows the shared test database must not keep (seeded taxonomy counts, GD-13). */
  onClose(fn: () => Promise<unknown>): void {
    this.#cleanups.push(fn);
  }

  async close(): Promise<void> {
    await this.infra.jobs.idle();
    for (const fn of this.#cleanups.reverse()) await fn();
    await this.media.close();
    for (const a of [this.auth, this.admin, this.apiKill, this.api]) await a.close();
    await this.infra.close();
  }

  get fx() {
    return this.api.fixtures;
  }

  get worker(): INestApplicationContext {
    return this.media.worker;
  }

  /** The kill-switch-aware flag check of the registry: is this FLAG key an AI feature? */
  async aiFlag(key: string): Promise<boolean> {
    return isAiFlag(this.api.app.get(FlagService, { strict: false }), key);
  }

  /** Memoized fixture shared by the resolvers of a suite (read-only use). */
  once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let v = this.#once.get(key) as Promise<T> | undefined;
    if (!v) this.#once.set(key, (v = make()));
    return v;
  }

  /** Relays the outbox, runs the consumers and waits for queued jobs (W2, W3, W5, W6, W9, …). */
  async settle(): Promise<void> {
    await this.infra.jobs.idle();
    await flush(this.api, this.worker);
    await this.infra.jobs.idle();
  }

  /** Rows of a raw query in the system context. */
  async q<T>(query: RawBuilder<T>): Promise<T[]> {
    return this.fx.worker.run({ actorType: 'system' }, async ({ db }) => (await query.execute(db)).rows);
  }

  /** Runs a callback in the system context (fixture writes). */
  sys<T>(fn: (db: Parameters<Parameters<TxRunner['run']>[1]>[0]['db']) => Promise<T>): Promise<T> {
    return this.fx.worker.run({ actorType: 'system' }, ({ db }) => fn(db));
  }

  // ---------------------------------------------------------------- actors

  async #actor(user: TestUser, kind: Actor['kind'], o: { org?: TestOrg; role?: string } = {}): Promise<Actor> {
    if (kind === 'staff') {
      const token = await this.fx.token(user, { staff: true });
      return { kind, user, token, client: ADMIN_CLIENT, c: api(this.admin, token, ADMIN_CLIENT) };
    }
    // Fresh aal2 sessions: AAL2 step-up routes accept them (owners act within the step-up window).
    const token = await this.fx.token(user, { acr: 'aal2' });
    return { kind, user, token, client: TEST_CLIENT, c: api(this.api, token, TEST_CLIENT), ...o };
  }

  /** A new user (verified email, aal2 session). */
  async user(o: { locale?: 'en' | 'fa' } = {}): Promise<Actor> {
    return this.#actor(await this.fx.user(o), 'user');
  }

  /** A new user with `role` in a new organization of `type` (or in `org`). */
  async member(type: OrgType, role: string = ownerRole(type), o: { org?: TestOrg } = {}): Promise<Actor> {
    const [user, org] = await Promise.all([this.fx.user(), o.org ? Promise.resolve(o.org) : this.fx.org(type)]);
    await this.fx.member(user, org, role);
    return this.#actor(user, 'member', { org, role });
  }

  /** Another member of the same organization (e.g. an approver who is not the requester). */
  async colleague(of: Actor, role: string): Promise<Actor> {
    return this.member(of.org!.type, role, { org: of.org! });
  }

  async staff(...roles: string[]): Promise<Actor> {
    return this.#actor(await this.fx.staff(...roles), 'staff');
  }

  async anonymous(): Promise<Caller> {
    return { kind: 'anonymous', token: await this.fx.anonymousToken(), client: TEST_CLIENT };
  }

  /** The BOLA attacker of user routes: an unrelated user (one per suite). */
  stranger(): Promise<Actor> {
    return this.once('stranger', () => this.user());
  }

  /** The BOLA attacker of organization routes: the same role in another organization of the same type (one per type and role). */
  rival(type: OrgType, role: string): Promise<Actor> {
    return this.once(`rival:${type}:${role}`, () => this.member(type, role));
  }

  // ------------------------------------------------------------ admin plane

  /** Rejects a pending four-eyes change through a second admin: no sweep change stays pending (one per op and target). */
  async rejectChange(changeId: string, role = 'platform_admin'): Promise<void> {
    const second = await this.staff(role);
    ok(
      await second.c.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'reject', reason: 'Contract sweep: rejected' }),
      'four-eyes reject',
    );
  }

  /** Expires pending changes about a fixed target (plans, flags, policies, MCP clients) that an interrupted run left behind. */
  async expirePending(targetId: string): Promise<void> {
    await this.q(
      sql`UPDATE admin.pending_admin_changes SET status = 'expired' WHERE target_entity_id = ${targetId}::uuid AND status = 'pending'`,
    );
  }

  // -------------------------------------------------------------- resources

  #published(p: PublishedOrg, type: OrgType): Actor {
    const user: TestUser = { id: p.userId, email: '', platformRoles: [] };
    return {
      kind: 'member',
      user,
      token: p.token,
      client: TEST_CLIENT,
      org: { id: p.id, type },
      role: ownerRole(type),
      c: api(this.api, p.token, TEST_CLIENT),
    };
  }

  /** A published provider (profile, service category, brand coverage, one exact location) and its owner. */
  async provider(o: { point?: { lat: number; lng: number }; location?: Json; services?: string[] } = {}): Promise<Published> {
    const p = await publishedProvider(this.api, this.n, {
      name: `Sweep Garage ${this.newId().slice(-8)}`,
      point: o.point ?? uniquePoint(),
      ...o,
    });
    return { as: this.#published(p, 'provider'), id: p.id, point: p.point, locationId: p.locationId };
  }

  /** A published vendor (basic plan, trade customers supported) with one active public item, and its owner. */
  async vendor(o: { point?: { lat: number; lng: number }; item?: Json } = {}): Promise<Published & { itemId: string }> {
    const v = await publishedVendor(this.api, this.n, {
      name: `Sweep Parts ${this.newId().slice(-8)}`,
      point: o.point ?? uniquePoint(),
      ...o,
    });
    return { as: this.#published(v, 'vendor'), id: v.id, point: v.point, locationId: v.locationId, itemId: v.itemId };
  }

  /** A vehicle row of a user or a fleet (fixtures, no VIN). */
  async vehicle(owner: Actor, o: { status?: 'active' | 'inactive' | 'in_repair'; year?: number } = {}): Promise<string> {
    return this.fx.vehicle(owner.kind === 'member' ? owner.org! : owner.user, this.n, o);
  }

  /** A unique valid VIN of the pilot region (model year 2014 for the lite decoder), registered for the projection scan. */
  vin(): string {
    const v = `NAAN01CA9EK${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    this.vins.add(v);
    return v;
  }

  /** Owner of a dual-scope vehicle route: a user (me routes) or a fleet member (fleet routes) with an active vehicle. */
  async vehicleOwner(route: Route, role = 'fleet_owner'): Promise<{ as: Actor; vehicleId: string; base: string }> {
    const as = route.scope === 'fleet' ? await this.member('fleet', role) : await this.user();
    if (as.org) await this.fx.subscription(as.org, 'fleet_20');
    const vehicleId = await this.vehicle(as);
    return { as, vehicleId, base: vehicleBase(route, as, vehicleId) };
  }

  /** An uploaded and processed media asset owned by the actor (or its organization). */
  async upload(as: Actor, purpose: string, o: { mime?: string; bytes?: Buffer; ownerOrg?: boolean } = {}): Promise<Json> {
    const mime = o.mime ?? 'image/jpeg';
    const bytes = o.bytes ?? (mime === 'application/pdf' ? tinyPdf() : await jpegWithExif());
    const owner =
      (o.ownerOrg ?? as.kind === 'member') && as.org
        ? { type: 'organization' as const, id: as.org.id }
        : { type: 'user' as const, id: as.user.id };
    return this.media.upload(as.token, { owner, purpose, mime, bytes });
  }

  /** Records an id the sweep considers sensitive in the projection scan (full VINs). */
  registerVin(vin: string): void {
    this.vins.add(vin);
  }

  newId(): string {
    return uuidv7();
  }
}

export interface Published {
  as: Actor;
  id: string;
  point: { lat: number; lng: number };
  locationId: string;
}

/** A map-area location input around a point (no location consent needed). */
export const area = (p: { lat: number; lng: number }, span = 0.05) => ({
  mode: 'map_center',
  viewport: { center: p, zoom: 13, bbox: { south: p.lat - span, west: p.lng - span, north: p.lat + span, east: p.lng + span } },
});

export const ownerRole = (type: OrgType): string => (type === 'hybrid_provider_vendor' ? 'provider_owner' : (`${type}_owner` as const));

/** The base path of a dual-scope vehicle route ({V} alias, 40 §0.3). */
export function vehicleBase(route: Route, as: Actor, vehicleId: string): string {
  return route.scope === 'fleet' ? `/v1/orgs/${as.org!.id}/fleet/vehicles/${vehicleId}` : `/v1/me/vehicles/${vehicleId}`;
}

/** Throws unless the response has the status (setup steps). */
export function ok<T = Json>(res: TestResponse<T>, what: string, status?: number): T {
  const want = status === undefined ? [200, 201, 202] : [status];
  if (!want.includes(res.status)) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 400)}`);
  return res.body;
}

export { sql };
