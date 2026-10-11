import { beforeEach, describe, expect, it } from 'vitest';
import { Authenticator, JwtKeyRing, SessionStore, TokenService, type Principal, type UserPrincipal } from '#libs/auth/index.js';
import { operationById, type Route } from '#libs/contract/index.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { MemoryKeyValueStore } from '#libs/infra/index.js';
import { aliasOrgTypes, Authorizer, InMemoryDirectory, rolesFor, WellFormedPurposeVerifier, type PurposeVerifier } from './index.js';

const crypto = new CryptoServices('test-master-secret-0123456789-abcdefghij');
let dir: InMemoryDirectory;
let kv: MemoryKeyValueStore;
let purposes: PurposeVerifier;

const authorizer = () => {
  const authenticator = new Authenticator({
    tokens: new TokenService(JwtKeyRing.derived(crypto.keys), 'https://id.carpal.app'),
    sessions: new SessionStore(kv),
    kv,
    hmac: crypto.hmac,
    audiences: { api: 'https://api.carpal.app', 'admin-api': 'https://admin-api.carpal.app' },
    strict: false,
  });
  return new Authorizer({ memberships: dir, organizations: dir, drivers: dir, purposes, authenticator, kv, cacheTtlMs: 30_000 });
};

beforeEach(() => {
  dir = new InMemoryDirectory();
  kv = new MemoryKeyValueStore();
  purposes = new WellFormedPurposeVerifier();
});

const now = () => Math.floor(Date.now() / 1000);
const user = (o: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user',
  userId: uuidv7(),
  clientId: 'cp-mobile',
  sessionId: uuidv7(),
  acr: 'aal1',
  authTime: now(),
  tokenId: 'j',
  scopes: [],
  ...o,
});
const anon: Principal = { kind: 'anonymous', clientId: 'cp-mobile', tokenId: 'j', anonKey: 'k', scopes: [] };
const route = (opId: string, scope?: string): Route => {
  const op = operationById(opId);
  return scope ? op.routes.find((r) => r.scope === scope)! : op.routes[0]!;
};
const check = (opId: string, principal: Principal, params: Record<string, string> = {}, o: { scope?: string; purpose?: string } = {}) =>
  authorizer().authorize({ route: route(opId, o.scope), opId, principal, params, purposeHeader: o.purpose });

describe('role groups (40 §0.5)', () => {
  it('expands groups, O+/M+ relative to the organization type, and ANY', () => {
    expect([...rolesFor(['O+'], 'fleet').roles]).toEqual(['fleet_owner']);
    expect([...rolesFor(['M+'], 'hybrid_provider_vendor').roles].sort()).toEqual(['provider_manager', 'provider_owner', 'vendor_owner']);
    expect(rolesFor(['ANY'], 'vendor').anyMember).toBe(true);
    expect(aliasOrgTypes('/v1/orgs/{org_id}/provider/profile')).toEqual(['provider', 'hybrid_provider_vendor']);
    expect(aliasOrgTypes('/v1/orgs/{org_id}/members')).toBeNull();
  });
});

describe('Authorizer', () => {
  it('PUB needs a token unless "no token"; USR needs a user (401 otherwise)', async () => {
    await expect(check('config.client', { kind: 'none' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(check('config.client', anon)).resolves.toMatchObject({ alternative: 0 });
    await expect(check('health.get', { kind: 'none' })).resolves.toBeTruthy();
    await expect(check('me.get', anon)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(check('me.get', user())).resolves.toBeTruthy();
  });

  it('ORG: active membership with an allowed role and the alias org type; otherwise 404', async () => {
    const orgId = uuidv7();
    const owner = user();
    const staffer = user();
    const outsider = user();
    dir.addOrg({ id: orgId, type: 'provider', status: 'active' });
    dir.addMember(owner.userId, orgId, 'provider_owner');
    dir.addMember(staffer.userId, orgId, 'provider_staff');

    const g = await check('provider.profile_put', owner, { org_id: orgId });
    expect(g.org).toEqual({ id: orgId, type: 'provider', role: 'provider_owner' });
    await expect(check('provider.profile_put', staffer, { org_id: orgId })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(check('provider.profile_put', outsider, { org_id: orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // A fleet organization cannot be reached through the {prv} alias even by its owner.
    const fleetId = uuidv7();
    dir.addOrg({ id: fleetId, type: 'fleet', status: 'active' });
    dir.addMember(owner.userId, fleetId, 'fleet_owner');
    await kv.delPrefix('authz:'); // membership change (identity invalidates the cache)
    await expect(check('provider.profile_put', owner, { org_id: fleetId })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Qualified groups report which group matched, for the use case.
    const inv = await check('org.member_invite', owner, { org_id: fleetId });
    expect(inv).toMatchObject({ matchedGroups: ['M+', 'FC'], qualifiers: ['fleet_driver only'] });
  });

  it('dual-scope routes: USR on {me}, ORG(F*) with DRV on {flt}', async () => {
    const orgId = uuidv7();
    const vehicleId = uuidv7();
    const driver = user();
    const manager = user();
    dir.addOrg({ id: orgId, type: 'fleet', status: 'active' });
    dir.addMember(driver.userId, orgId, 'fleet_driver');
    dir.addMember(manager.userId, orgId, 'fleet_manager');
    expect(await check('vehicles.get', driver, { vehicle_id: vehicleId }, { scope: 'me' })).toMatchObject({ alternative: 0 });
    // Driver without an assignment to the vehicle: 404; manager is not driver-scoped.
    await expect(check('vehicles.get', driver, { org_id: orgId, vehicle_id: vehicleId }, { scope: 'fleet' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    dir.assign(orgId, driver.userId, vehicleId);
    expect(await check('vehicles.get', driver, { org_id: orgId, vehicle_id: vehicleId }, { scope: 'fleet' })).toMatchObject({
      driverScoped: true,
      org: { role: 'fleet_driver' },
    });
    expect(await check('vehicles.get', manager, { org_id: orgId, vehicle_id: vehicleId }, { scope: 'fleet' })).toMatchObject({
      driverScoped: false,
    });
  });

  it('defers ORG on single-path operations to the use case (USR | ORG(ANY))', async () => {
    const g = await check('jobs.get', user(), { job_id: uuidv7() });
    expect(g.alternative).toBe(0);
    const orgId = uuidv7();
    const member = user();
    dir.addOrg({ id: orgId, type: 'vendor', status: 'active' });
    dir.addMember(member.userId, orgId, 'vendor_staff');
    expect(await authorizer().authorizeOrg(member, orgId, ['ANY'])).toMatchObject({ role: 'vendor_staff' });
    await expect(authorizer().authorizeOrg(user(), orgId, ['ANY'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('STF roles, PURP header and step-up tags', async () => {
    const staff = user({ kind: 'staff', acr: 'aal3' });
    dir.addPlatformRole(staff.userId, 'platform_support');
    const purpose = `case:${uuidv7()}`;
    expect(await check('admin.user_get', staff, { user_id: uuidv7() }, { purpose })).toMatchObject({
      platformRoles: ['platform_support'],
      purpose: { kind: 'case' },
    });
    await expect(check('admin.user_get', staff, { user_id: uuidv7() })).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(check('admin.dsr_execute_deletion', staff, { request_id: uuidv7() }, { purpose })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(check('admin.user_get', user(), { user_id: uuidv7() }, { purpose })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    purposes = { verify: async () => false };
    await expect(check('admin.user_get', staff, { user_id: uuidv7() }, { purpose })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const owner = user({ acr: 'aal1' });
    await expect(check('vehicles.vin_reveal', owner, { vehicle_id: uuidv7() }, { scope: 'me' })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(await check('vehicles.vin_reveal', user({ acr: 'aal2' }), { vehicle_id: uuidv7() }, { scope: 'me' })).toBeTruthy();
  });

  it('caches memberships for at most the TTL and invalidates on demand', async () => {
    const orgId = uuidv7();
    const u = user();
    dir.addOrg({ id: orgId, type: 'provider', status: 'active' });
    dir.addMember(u.userId, orgId, 'provider_owner');
    const a = authorizer();
    await a.authorize({
      route: route('provider.profile_put'),
      opId: 'provider.profile_put',
      principal: u,
      params: { org_id: orgId },
      purposeHeader: undefined,
    });
    dir.members.set(u.userId, []);
    // Still cached...
    await expect(
      a.authorize({
        route: route('provider.profile_put'),
        opId: 'provider.profile_put',
        principal: u,
        params: { org_id: orgId },
        purposeHeader: undefined,
      }),
    ).resolves.toBeTruthy();
    // ...until the identity module invalidates it on the membership change.
    await a.invalidateUser(u.userId);
    await expect(
      a.authorize({
        route: route('provider.profile_put'),
        opId: 'provider.profile_put',
        principal: u,
        params: { org_id: orgId },
        purposeHeader: undefined,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
