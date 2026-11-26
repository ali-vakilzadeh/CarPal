// The consumer audience of the forwarder (SEC-WEB-5, GD-08 amendment), derived from the generated registry: a route
// is forwarded when it is on the api host and either (a) is outside the organization scope /v1/orgs/{org_id}/… and
// admits a USR, PUB or LNK principal — routes that only name an organization as their target (follows, favourites,
// /v1/public/orgs/{org_id}/… reads) are consumer routes (P5 fix) —, (b) is a /v1/orgs/{org_id}/fleet/… route that
// admits DRV (fleet drivers use the PWA, P12), or (c) is the {org} route of an operation named in WORKSHOP_OPERATIONS
// (the CarPal Workshop route group /<locale>/provider, provider plan PRV-GD-01 and PRV-BR-08: a named list of
// operation ids, never a path prefix). Everything else — other {org} business routes, the admin plane, auth-host
// operations — answers 404 at the BFF.
import { OPERATIONS, type OperationId, type OperationRoute } from '@carpal/api-contracts';

/**
 * The provider operations the Workshop PWA calls on their /v1/orgs/{org_id}/… route (frontend/provider-dev-plan.json
 * PRV-BR-08 with the PW1 amendment). Operations of the Workshop whose routes are already consumer routes (onboarding.*,
 * org.create, media.*, jobs.get, notifications.* with organization_id, taxonomy, comments.*, reports.create) are not
 * listed: rule (a) admits them. Grouped by the stage that first needs them.
 */
export const WORKSHOP_OPERATIONS = [
  // PW1 shell and Today
  'org.get',
  'subscription.org_get',
  'provider.profile_get',
  'provider.appointments_list',
  'reviews.org_list',
  'review_approvals.list',
  'provider.portfolio_list',
  'provider.insights_get',
  // PW2 compact onboarding
  'org.locations_list',
  'org.location_create',
  'org.location_update',
  'org.location_pin_check',
  'geo.reverse',
  'org.consents_list',
  'org.consents_grant',
  'org.verification_submit',
  'provider.profile_put',
  'provider.publish',
  'provider.service_categories_list',
  'provider.service_category_create',
  'provider.coverage_list',
  'provider.coverage_create',
  'availability.rules_list',
  'availability.rule_create',
  // PW3 requests and PW4 update / close job
  'provider.appointments_get',
  'provider.appointments_update',
  'provider.appointments_transition',
  'pre_visit.provider_get',
  'provider.notes_list',
  'provider.note_create',
  'provider.participants_list',
  'provider.calendar',
  'ai.appointment_suggestions',
  // PW5 review replies and approvals
  'reviews.org_get',
  'review_responses.create',
  'review_responses.update',
  'review_responses.publish',
  'review_responses.delete',
  'review_approvals.answer',
  'ai.review_response_draft',
  // PW7 before/after photos (posts: the optional share to the feed)
  'provider.portfolio_create',
  'provider.portfolio_update',
  'provider.portfolio_consent_request',
  'provider.portfolio_publish',
  'ai.showcase_compose',
  'posts.create',
  'posts.publish',
] as const satisfies readonly OperationId[];

const WORKSHOP = new Set<string>(WORKSHOP_OPERATIONS);

export interface AllowedRoute {
  opId: OperationId;
  method: string;
  route: OperationRoute;
  pattern: RegExp;
}

export type RouteMatch =
  | { kind: 'ok'; route: AllowedRoute; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

const CONSUMER_PRINCIPALS = ['USR', 'PUB', 'LNK'];

export function isConsumerRoute(route: OperationRoute): boolean {
  if (route.host !== 'api') return false;
  const admits = (tags: string[]) => route.principals.some((alt) => alt.some((t) => tags.includes(t.tag)));
  if (!route.path.startsWith('/v1/orgs/{org_id}')) return admits(CONSUMER_PRINCIPALS);
  return route.path.startsWith('/v1/orgs/{org_id}/fleet/') && admits(['DRV']);
}

/** Rule (c): the organization route of a listed Workshop operation (never a fleet route, never another host). */
export function isWorkshopRoute(opId: string, route: OperationRoute): boolean {
  return (
    WORKSHOP.has(opId) &&
    route.host === 'api' &&
    (route.path === '/v1/orgs/{org_id}' || route.path.startsWith('/v1/orgs/{org_id}/')) &&
    !route.path.startsWith('/v1/orgs/{org_id}/fleet/')
  );
}

/** Path parameter values: one non-empty segment of unreserved or percent-encoded characters (ids, slugs, keys). */
const SEGMENT = '((?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+)';

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((part) => (/^\{[a-z_]+\}$/.test(part) ? SEGMENT : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

export class ConsumerAllowlist {
  readonly routes: readonly AllowedRoute[];

  constructor(operations: Readonly<Record<string, (typeof OPERATIONS)[OperationId]>> = OPERATIONS) {
    const routes: AllowedRoute[] = [];
    for (const [opId, op] of Object.entries(operations)) {
      for (const route of op.routes) {
        if (isConsumerRoute(route) || isWorkshopRoute(opId, route)) routes.push({ opId: opId as OperationId, method: op.method, route, pattern: compile(route.path) });
      }
    }
    // Literal segments win over parameters (e.g. /v1/me/vehicles/transfers before /v1/me/vehicles/{vehicle_id}).
    routes.sort((a, b) => literalWeight(b.route.path) - literalWeight(a.route.path));
    this.routes = routes;
  }

  match(method: string, path: string): RouteMatch {
    const allow = new Set<string>();
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      if (r.method !== method) {
        allow.add(r.method);
        continue;
      }
      const params: Record<string, string> = {};
      r.route.pathParams.forEach((name, i) => (params[name] = m[i + 1]!));
      return { kind: 'ok', route: r, params };
    }
    return allow.size ? { kind: 'method_not_allowed', allow: [...allow] } : { kind: 'not_found' };
  }
}

function literalWeight(path: string): number {
  return path.split('/').filter((p) => p && !p.startsWith('{')).length;
}

/**
 * Rejects paths that could mean something else upstream than they mean here: encoded slashes or backslashes, dot
 * segments, empty segments, and anything outside printable ASCII.
 */
export function isCanonicalPath(path: string): boolean {
  if (!/^\/[\x21-\x7e]*$/.test(path)) return false;
  if (/%2f|%5c|\\/i.test(path)) return false;
  return path
    .split('/')
    .slice(1)
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^%2e/i.test(seg));
}
