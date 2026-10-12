// L4 authorization (41 §5 step 6; 40 §0.4-0.5, SEC-AZ-1..7, SEC-ADM-5).
// Guards are built from the parsed sec tags of each route: the caller must
// satisfy ONE principal alternative (PUB, USR, ORG(groups), DRV, STF(roles),
// LNK) and ALL tags (AAL2/AAL3, PURP, ATT). Roles come from server state with
// a cache of at most 30 s. A caller who is authenticated but not allowed gets
// 404 NOT_FOUND, never 403, so private records are not disclosed (SEC-AZ-2),
// and errors never say which check failed (SEC-OUT-5).
import { ApiError, ROLE_GROUPS, type RoleGroupName, type Route, type SecTag } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { ID_PATTERN } from '#libs/crypto/index.js';
import type { Authenticator, Principal, UserPrincipal } from '#libs/auth/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';
import type {
  AccessPurpose,
  DriverAssignments,
  Membership,
  MembershipDirectory,
  OrganizationDirectory,
  OrganizationInfo,
  PurposeVerifier,
} from './ports.js';

/** What the caller was allowed as, handed to the use case. */
export interface AccessGrant {
  /** Index of the satisfied principal alternative (0 = first prefix of A | B). */
  alternative: number;
  /** Path organization, authorized (ORG on {org}/{prv}/{vnd}/{flt} routes). */
  org?: { id: string; type: OrgType; role: string };
  /** Role groups of the ORG tag that contain the caller's role (for qualifiers such as "FC: fleet_driver only"). */
  matchedGroups: string[];
  /** Platform roles of a staff caller. */
  platformRoles: string[];
  /** The caller is a fleet driver: the use case limits reads/writes to assigned vehicles (SEC-AZ-7). */
  driverScoped: boolean;
  /** ORG(...) on a route without an organization in the path: the use case resolves the organization from the target and calls authorizeOrg(). */
  deferredOrg?: { groups: string[]; qualifier?: string };
  /** Qualifiers of satisfied tags that the use case must apply ("by target", "lower roles only", "own reports", ...). */
  qualifiers: string[];
  /** LNK(type): a link token of this type is expected in the body. */
  link?: string;
  purpose?: AccessPurpose;
  /** Conditional step-up (AAL3 with arguments): the use case calls requireAssurance when the condition holds. */
  conditionalAssurance?: { level: 'aal2' | 'aal3'; when: string[] };
}

export interface AuthorizeInput {
  route: Route;
  opId: string;
  principal: Principal;
  params: Record<string, string>;
  purposeHeader: string | undefined;
  attestation?: { attestation?: string; pow?: string; clientId?: string };
}

export interface AuthorizerOptions {
  memberships: MembershipDirectory;
  organizations: OrganizationDirectory;
  drivers: DriverAssignments;
  purposes: PurposeVerifier;
  authenticator: Authenticator;
  kv: KeyValueStore;
  /** ≤ 30 s (SEC-AU-3). 0 disables the cache. */
  cacheTtlMs: number;
}

const PURPOSE = /^(case|dispute|dsr|verification|approval):([0-9a-f-]{36})$/;
const ALIAS_TYPES: Record<string, OrgType[]> = {
  provider: ['provider', 'hybrid_provider_vendor'],
  vendor: ['vendor', 'hybrid_provider_vendor'],
  fleet: ['fleet'],
};
const ROLE_PREFIX: Record<OrgType, string[]> = {
  provider: ['provider_'],
  vendor: ['vendor_'],
  fleet: ['fleet_'],
  hybrid_provider_vendor: ['provider_', 'vendor_'],
};

class Denied extends Error {
  constructor(readonly status: 401 | 404) {
    super(status === 401 ? 'unauthenticated' : 'not found');
  }
}

/** Org type required by the path alias ({prv}, {vnd}, {flt}), or null for {org}. */
export function aliasOrgTypes(path: string): OrgType[] | null {
  const m = /^\/v1\/orgs\/\{org_id\}\/(provider|vendor|fleet)(\/|$)/.exec(path);
  return m ? ALIAS_TYPES[m[1]!]! : null;
}

/** Roles allowed by a list of role groups for an organization type (40 §0.5). */
export function rolesFor(groups: string[], orgType: OrgType | null): { roles: Set<string>; anyMember: boolean } {
  const roles = new Set<string>();
  let anyMember = false;
  for (const g of groups) {
    const group = ROLE_GROUPS[g as RoleGroupName];
    if (!group) throw new Error(`unknown role group ${g}`);
    if ('anyMember' in group && group.anyMember) anyMember = true;
    for (const r of group.roles) {
      if ('orgTypeRelative' in group && group.orgTypeRelative && orgType && !ROLE_PREFIX[orgType].some((p) => r.startsWith(p))) continue;
      roles.add(r);
    }
  }
  return { roles, anyMember };
}

export class Authorizer {
  constructor(private readonly o: AuthorizerOptions) {}

  async authorize(input: AuthorizeInput): Promise<AccessGrant> {
    const { route } = input;
    let best: Denied | null = null;
    let grant: AccessGrant | null = null;
    for (const [i, alternative] of route.security.principals.entries()) {
      try {
        grant = await this.#alternative(i, alternative, input);
        break;
      } catch (err) {
        if (!(err instanceof Denied)) throw err;
        // Prefer telling an unauthenticated caller to authenticate.
        if (!best || err.status === 401) best = err;
      }
    }
    if (!grant) {
      if (best?.status === 401)
        throw new ApiError('UNAUTHENTICATED', {
          detail: 'route needs a user',
          headers: { 'www-authenticate': 'DPoP algs="ES256", Bearer' },
        });
      throw new ApiError('NOT_FOUND', { detail: 'authorization failed' });
    }
    await this.#tags(route.security.tags, grant, input);
    return grant;
  }

  async #alternative(index: number, tags: SecTag[], input: AuthorizeInput): Promise<AccessGrant> {
    const { principal, route, params } = input;
    const grant: AccessGrant = { alternative: index, matchedGroups: [], platformRoles: [], driverScoped: false, qualifiers: [] };
    for (const tag of tags) {
      switch (tag.tag) {
        case 'PUB':
          if (tag.qualifier !== 'no token' && principal.kind === 'none') throw new Denied(401);
          break;
        case 'USR':
          if (principal.kind !== 'user') throw new Denied(principal.kind === 'staff' ? 404 : 401);
          break;
        case 'STF': {
          if (principal.kind !== 'staff') throw new Denied(principal.kind === 'none' || principal.kind === 'anonymous' ? 401 : 404);
          const roles = await this.#platformRoles(principal.userId);
          const allowed = tag.args.flatMap((g) => [...rolesFor([g], null).roles]);
          if (!roles.some((r) => allowed.includes(r))) throw new Denied(404);
          grant.platformRoles = roles;
          if (tag.qualifier) grant.qualifiers.push(tag.qualifier);
          break;
        }
        case 'ORG': {
          if (principal.kind !== 'user') throw new Denied(principal.kind === 'staff' ? 404 : 401);
          if (tag.qualifier) grant.qualifiers.push(tag.qualifier);
          const orgId = params.org_id;
          if (!route.pathParams.includes('org_id') || !orgId) {
            grant.deferredOrg = { groups: tag.args, ...(tag.qualifier ? { qualifier: tag.qualifier } : {}) };
            break;
          }
          // DRV in the same alternative admits fleet drivers too, limited to their assigned vehicles (40 §0.4 DRV, SEC-AZ-7).
          const drivers = tags.some((t) => t.tag === 'DRV') ? ['fleet_driver'] : [];
          const r = await this.#orgAccess(principal, orgId, tag.args, aliasOrgTypes(route.path), drivers);
          if (!r) throw new Denied(404);
          grant.org = { id: orgId, type: r.org.type, role: r.role };
          grant.matchedGroups = r.matchedGroups;
          break;
        }
        case 'DRV': {
          // Restricts fleet drivers only; other fleet roles are unaffected (SEC-AZ-7).
          if (grant.deferredOrg) {
            // Organization resolved later: the use case applies DRV after authorizeOrg().
            grant.qualifiers.push(tag.qualifier ? `DRV:${tag.qualifier}` : 'DRV');
            break;
          }
          if (grant.org?.role !== 'fleet_driver') break;
          grant.driverScoped = true;
          if (tag.qualifier) grant.qualifiers.push(tag.qualifier);
          // A qualified DRV ("own reports") still needs the assignment; the use case applies the qualifier on top.
          const vehicleId = params.vehicle_id;
          if (grant.org && vehicleId) {
            if (!(await this.o.drivers.isAssigned(grant.org.id, principal.kind === 'user' ? principal.userId : '', vehicleId)))
              throw new Denied(404);
          }
          break;
        }
        case 'LNK':
          grant.link = tag.args[0];
          break;
        default:
          throw new Error(`unexpected principal tag ${tag.tag}`);
      }
    }
    return grant;
  }

  async #tags(tags: SecTag[], grant: AccessGrant, input: AuthorizeInput): Promise<void> {
    for (const tag of tags) {
      switch (tag.tag) {
        case 'AAL2':
        case 'AAL3': {
          const level = tag.tag === 'AAL2' ? 'aal2' : 'aal3';
          if (tag.args.length > 0 || tag.qualifier) grant.conditionalAssurance = { level, when: tag.args };
          else this.o.authenticator.requireAssurance(input.principal, level);
          break;
        }
        case 'PURP': {
          const m = input.purposeHeader ? PURPOSE.exec(input.purposeHeader) : null;
          if (!m || !ID_PATTERN.test(m[2]!))
            throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Access-Purpose missing or malformed' });
          const purpose: AccessPurpose = { kind: m[1] as AccessPurpose['kind'], id: m[2]!, value: input.purposeHeader! };
          const staff = input.principal as UserPrincipal;
          if (!(await this.o.purposes.verify(staff.userId, purpose, input.opId)))
            throw new ApiError('NOT_FOUND', { detail: 'purpose not in the caller queue' });
          grant.purpose = purpose;
          break;
        }
        case 'ATT':
          if (tag.args.length === 0) await this.o.authenticator.checkAttestation({ ...input.attestation, opId: input.opId });
          break;
        default:
          break; // IDEM, ETAG, RL, FLAG, ENT, CNS, ASYNC, AUD, RSN, 4EYES, PII: other pipeline steps or the use case
      }
    }
  }

  /**
   * ORG check for a known organization (path, or resolved from a target by
   * the use case): active membership with a role of the groups, organization
   * type matching the alias. Null when not allowed.
   */
  async #orgAccess(principal: UserPrincipal, orgId: string, groups: string[], aliasTypes: OrgType[] | null, extraRoles: string[] = []) {
    if (!ID_PATTERN.test(orgId)) return null;
    const membership = (await this.#memberships(principal.userId)).find((m) => m.orgId === orgId);
    if (!membership) return null;
    const org = await this.#organization(orgId);
    if (!org || org.status === 'merged' || org.status === 'archived') return null;
    if (aliasTypes && !aliasTypes.includes(org.type)) return null;
    const matchedGroups = groups.filter((g) => {
      const { roles, anyMember } = rolesFor([g], org.type);
      return anyMember || roles.has(membership.role);
    });
    if (matchedGroups.length === 0) {
      if (org.type !== 'fleet' || !extraRoles.includes(membership.role)) return null;
      matchedGroups.push('DRV');
    }
    return { org, role: membership.role, matchedGroups };
  }

  /** For ORG(by target) and USR | ORG(ANY) single-path operations: authorize the organization the use case resolved. */
  async authorizeOrg(
    principal: Principal,
    orgId: string,
    groups: string[],
  ): Promise<{ id: string; type: OrgType; role: string; matchedGroups: string[] }> {
    if (principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const r = await this.#orgAccess(principal, orgId, groups, null);
    if (!r) throw new ApiError('NOT_FOUND', { detail: 'organization not authorized' });
    return { id: orgId, type: r.org.type, role: r.role, matchedGroups: r.matchedGroups };
  }

  /** Active memberships of the caller (cached ≤ 30 s). */
  async memberships(userId: string): Promise<Membership[]> {
    return this.#memberships(userId);
  }

  async #memberships(userId: string): Promise<Membership[]> {
    return this.#cached(`authz:mem:${userId}`, () => this.o.memberships.memberships(userId, 'user'));
  }

  async #platformRoles(userId: string): Promise<string[]> {
    return this.#cached(`authz:plat:${userId}`, () => this.o.memberships.platformRoles(userId));
  }

  async #organization(orgId: string): Promise<OrganizationInfo | null> {
    return this.#cached(`authz:org:${orgId}`, () => this.o.organizations.get(orgId));
  }

  async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.o.cacheTtlMs <= 0) return load();
    const hit = await this.o.kv.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await load();
    await this.o.kv.set(key, JSON.stringify(value), { ttlMs: this.o.cacheTtlMs });
    return value;
  }

  /** Called by identity/organization on any membership, role or status change (SEC-AU-3). */
  async invalidateUser(userId: string): Promise<void> {
    await this.o.kv.del(`authz:mem:${userId}`);
    await this.o.kv.del(`authz:plat:${userId}`);
  }

  async invalidateOrganization(orgId: string): Promise<void> {
    await this.o.kv.del(`authz:org:${orgId}`);
  }
}
