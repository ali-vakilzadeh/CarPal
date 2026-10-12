// BOLA / BFLA matrices driven by operations.json (41 §8, 40 Appendix C,
// SEC-AZ-1..7). For every route: which callers must get through (allowed) and
// which must be refused with which status (denied): no token → 401,
// anonymous on a user route → 401, a user or member without an allowed role
// → 404 (never 403), a member of another organization (BOLA) → 404, staff
// without the role → 404, a stale session on a step-up route → 401.
import { aliasOrgTypes, rolesFor } from '#libs/authz/index.js';
import type { Operation, Route, SecTag } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { uuidv7 } from '#libs/crypto/index.js';
import type { Fixtures, TestOrg, TestUser } from './fixtures.js';

export type PrincipalSpec =
  | { kind: 'none' }
  | { kind: 'anonymous' }
  | { kind: 'user'; acr?: 'aal1' | 'aal2' | 'aal3' }
  | { kind: 'member'; orgType: OrgType; role: string; acr?: 'aal1' | 'aal2' | 'aal3'; foreignOrg?: boolean }
  | { kind: 'staff'; role: string };

export interface DeniedSpec {
  spec: PrincipalSpec;
  status: 401 | 404;
  why: string;
}

export interface RouteMatrix {
  op: Operation;
  route: Route;
  allowed: PrincipalSpec[];
  denied: DeniedSpec[];
}

const ORG_TYPES: OrgType[] = ['provider', 'vendor', 'fleet', 'hybrid_provider_vendor'];
const ROLE_PREFIX: Record<OrgType, string[]> = {
  provider: ['provider_'],
  vendor: ['vendor_'],
  fleet: ['fleet_'],
  hybrid_provider_vendor: ['provider_', 'vendor_'],
};
const ALL_ORG_ROLES = [
  'provider_owner',
  'provider_manager',
  'provider_staff',
  'vendor_owner',
  'vendor_staff',
  'fleet_owner',
  'fleet_manager',
  'fleet_maintenance_coordinator',
  'fleet_driver',
  'fleet_viewer',
];
const STAFF_ROLES = ['platform_admin', 'platform_moderator', 'platform_support', 'platform_community_reviewer'];

const rolesOfType = (t: OrgType): string[] => ALL_ORG_ROLES.filter((r) => ROLE_PREFIX[t].some((p) => r.startsWith(p)));

function stepUp(route: Route): 'aal2' | 'aal3' | undefined {
  const t = route.security.tags.find((x) => (x.tag === 'AAL2' || x.tag === 'AAL3') && x.args.length === 0 && !x.qualifier);
  return t ? (t.tag === 'AAL2' ? 'aal2' : 'aal3') : undefined;
}

/** Allowed (orgType, role) pairs of an ORG tag on a route with the organization in the path. */
function orgPairs(tag: SecTag, route: Route, drv: SecTag | undefined): { orgType: OrgType; role: string }[] {
  const types = aliasOrgTypes(route.path) ?? ORG_TYPES;
  const out: { orgType: OrgType; role: string }[] = [];
  for (const orgType of types) {
    const { roles, anyMember } = rolesFor(tag.args, orgType);
    // DRV admits fleet drivers in the same alternative (limited to assigned vehicles).
    if (drv && orgType === 'fleet') roles.add('fleet_driver');
    for (const role of rolesOfType(orgType)) {
      if (!anyMember && !roles.has(role)) continue;
      // A driver needs an assignment to the path vehicle (DriverAssignments: none until S8).
      if (role === 'fleet_driver' && drv && route.pathParams.includes('vehicle_id')) continue;
      out.push({ orgType, role });
    }
  }
  return out;
}

export function routeMatrix(op: Operation, route: Route): RouteMatrix {
  const acr = stepUp(route);
  const allowed: PrincipalSpec[] = [];
  const allowedRoles = new Set<string>();
  const allowedStaff = new Set<string>();
  let userAllowed = false;
  let anonAllowed = false;
  let noneAllowed = false;
  let orgInPath = false;
  for (const alt of route.security.principals) {
    const pub = alt.find((t) => t.tag === 'PUB');
    const org = alt.find((t) => t.tag === 'ORG');
    const drv = alt.find((t) => t.tag === 'DRV');
    const stf = alt.find((t) => t.tag === 'STF');
    if (pub?.qualifier === 'no token') noneAllowed = true;
    else if (pub) {
      anonAllowed = true;
      userAllowed = true;
    }
    if (alt.some((t) => t.tag === 'USR')) userAllowed = true;
    if (org && route.pathParams.includes('org_id')) {
      orgInPath = true;
      for (const p of orgPairs(org, route, drv)) {
        allowedRoles.add(`${p.orgType}:${p.role}`);
        allowed.push({ kind: 'member', ...p, ...(acr ? { acr } : {}) });
      }
    } else if (org) userAllowed = true; // organization resolved by the use case: any user passes the guard
    if (stf) for (const r of rolesFor(stf.args, null).roles) allowedStaff.add(r);
  }
  if (noneAllowed) allowed.unshift({ kind: 'none' });
  if (anonAllowed) allowed.unshift({ kind: 'anonymous' });
  if (userAllowed) allowed.unshift({ kind: 'user', ...(acr ? { acr } : {}) });
  for (const r of allowedStaff) allowed.push({ kind: 'staff', role: r });

  const denied: DeniedSpec[] = [];
  const admin = route.host === 'admin-api';
  if (!noneAllowed) denied.push({ spec: { kind: 'none' }, status: 401, why: 'no token' });
  if (!noneAllowed && !anonAllowed) denied.push({ spec: { kind: 'anonymous' }, status: 401, why: 'anonymous token on a user route' });
  if (!noneAllowed && !anonAllowed && !userAllowed)
    denied.push({
      spec: { kind: 'user' },
      status: admin ? 401 : 404,
      why: admin ? 'consumer token on the admin plane' : 'user without membership',
    });
  if (acr && userAllowed) denied.push({ spec: { kind: 'user', acr: 'aal1' }, status: 401, why: `stale session on an ${acr} route` });
  if (orgInPath) {
    const types = aliasOrgTypes(route.path) ?? ORG_TYPES;
    for (const orgType of types) {
      for (const role of rolesOfType(orgType)) {
        if (!allowedRoles.has(`${orgType}:${role}`))
          denied.push({ spec: { kind: 'member', orgType, role, ...(acr ? { acr } : {}) }, status: 404, why: `role ${role} not allowed` });
      }
    }
    const first = allowed.find((a) => a.kind === 'member');
    if (first) denied.push({ spec: { ...first, foreignOrg: true }, status: 404, why: 'member of another organization (BOLA)' });
  }
  if (admin)
    for (const r of STAFF_ROLES)
      if (!allowedStaff.has(r)) denied.push({ spec: { kind: 'staff', role: r }, status: 404, why: `staff role ${r} not allowed` });
  return { op, route, allowed, denied };
}

export interface MaterializedRequest {
  path: string;
  token?: string;
  headers: Record<string, string>;
  client: string | null;
}

/** Valid sample values of the non-Id path parameters (their schemas come from libs/contract). */
const SAMPLE_PATH_VALUES: Record<string, string> = {
  collection: 'service-categories',
  flow_type: 'individual',
  slug: 'sample-org',
  report_type: 'costs',
  role: 'platform_moderator',
  key: 'map.enabled',
  dashboard_key: 'activation',
};

const fill = (route: Route, params: Record<string, string>): string =>
  route.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => params[name] ?? SAMPLE_PATH_VALUES[name] ?? uuidv7());

/**
 * Builds a request for a spec on a route. Users, organizations, memberships
 * and tokens are cached per spec, so whole-registry sweeps stay fast.
 */
export class PrincipalFactory {
  readonly #cache = new Map<string, Promise<{ user?: TestUser; org?: TestOrg; token?: string }>>();

  constructor(private readonly fx: Fixtures) {}

  #get(key: string, make: () => Promise<{ user?: TestUser; org?: TestOrg; token?: string }>) {
    let v = this.#cache.get(key);
    if (!v) this.#cache.set(key, (v = make()));
    return v;
  }

  async request(spec: PrincipalSpec, route: Route): Promise<MaterializedRequest> {
    const headers: Record<string, string> = {};
    if (route.security.tags.some((t) => t.tag === 'PURP')) headers['carpal-access-purpose'] = `case:${uuidv7()}`;
    const params: Record<string, string> = {};
    let token: string | undefined;
    let client: string | null = 'cp-mobile/1.0.0 (ios 17.4)';
    switch (spec.kind) {
      case 'none':
        break;
      case 'anonymous':
        token = (await this.#get('anon', async () => ({ token: await this.fx.anonymousToken() }))).token;
        break;
      case 'user': {
        const acr = spec.acr ?? 'aal1';
        const authTime = acr === 'aal1' ? undefined : Math.floor(Date.now() / 1000);
        token = (
          await this.#get(`user:${acr}`, async () => {
            const user = await this.fx.user();
            return { user, token: await this.fx.token(user, { acr, ...(authTime ? { authTime } : {}) }) };
          })
        ).token;
        break;
      }
      case 'member': {
        const acr = spec.acr ?? 'aal1';
        const m = await this.#get(`member:${spec.orgType}:${spec.role}:${acr}`, async () => {
          const user = await this.fx.user();
          const org = await this.fx.org(spec.orgType);
          await this.fx.member(user, org, spec.role);
          return { user, org, token: await this.fx.token(user, { acr }) };
        });
        token = m.token;
        params.org_id = spec.foreignOrg
          ? (await this.#get(`victim:${spec.orgType}`, async () => ({ org: await this.fx.org(spec.orgType) }))).org!.id
          : m.org!.id;
        break;
      }
      case 'staff': {
        token = (
          await this.#get(`staff:${spec.role}`, async () => {
            const user = await this.fx.staff(spec.role);
            return { user, token: await this.fx.token(user, { staff: true }) };
          })
        ).token;
        client = 'cp-web-admin/1.0.0 (web 17.4)';
        break;
      }
    }
    if (spec.kind === 'staff' || route.host === 'admin-api') client = 'cp-web-admin/1.0.0 (web 17.4)';
    return { path: fill(route, params), ...(token ? { token } : {}), headers, client };
  }
}
