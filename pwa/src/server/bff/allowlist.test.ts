import { OPERATIONS } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { ConsumerAllowlist, isCanonicalPath } from './allowlist';

const allowlist = new ConsumerAllowlist();
const opOf = (method: string, path: string) => {
  const m = allowlist.match(method, path);
  return m.kind === 'ok' ? m.route.opId : m.kind;
};

describe('consumer allowlist (SEC-WEB-5, GD-08 amendment)', () => {
  it('holds the consumer routes and the 18 fleet driver routes of the registry', () => {
    const fleet = allowlist.routes.filter((r) => r.route.path.startsWith('/v1/orgs/'));
    expect(fleet).toHaveLength(18);
    expect(fleet.every((r) => r.route.path.startsWith('/v1/orgs/{org_id}/fleet/'))).toBe(true);
    expect(allowlist.routes.length - fleet.length).toBe(170);
    expect(allowlist.routes.every((r) => r.route.host === 'api')).toBe(true);
  });

  it('matches consumer operations by method and path', () => {
    expect(opOf('GET', '/v1/me')).toBe('me.get');
    expect(opOf('GET', '/v1/config/client')).toBe('config.client');
    expect(opOf('POST', '/v1/me/vehicles')).toBe('vehicles.create');
    expect(opOf('GET', '/v1/me/vehicles/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe('vehicles.get');
    expect(opOf('GET', '/v1/orgs/0193/fleet/vehicles/0194/issues')).toBe('issues.list');
  });

  it('admits consumer routes that name an organization as their target (P5)', () => {
    expect(opOf('PUT', '/v1/me/follows/0193')).toBe('follows.put');
    expect(opOf('DELETE', '/v1/me/favorites/0193')).toBe('favorites.delete');
    expect(opOf('GET', '/v1/public/orgs/0193/reviews')).toBe('public.org_reviews');
    expect(opOf('POST', '/v1/public/orgs/0193/inventory/search')).toBe('public.org_inventory_search');
    expect(opOf('GET', '/v1/public/orgs/0193/availability')).toBe('public.availability');
    // The organization-scoped route of the same operation stays out (the requester's own route is /v1/me/inquiries).
    expect(opOf('POST', '/v1/orgs/0193/inquiries')).toBe('not_found');
    expect(opOf('POST', '/v1/me/inquiries')).toBe('inquiries.create');
  });

  it('prefers literal segments over parameters', () => {
    // Every literal-path route wins over a parameter route that would match the same path.
    for (const r of allowlist.routes) {
      const literal = r.route.path;
      if (literal.includes('{')) continue;
      expect(opOf(r.method, literal), literal).toBe(r.opId);
    }
  });

  it('refuses business, admin and auth-host routes and unknown paths', () => {
    expect(opOf('GET', '/v1/orgs/0193/locations')).toBe('not_found');
    expect(opOf('GET', '/v1/orgs/0193/fleet/members')).toBe('not_found');
    expect(opOf('GET', '/v1/admin/flags')).toBe('not_found');
    expect(opOf('POST', '/v1/auth/signin')).toBe('not_found');
    expect(opOf('POST', '/oauth/token')).toBe('not_found');
    expect(opOf('GET', '/v1/me/')).toBe('not_found');
  });

  it('reports the allowed methods of a known path', () => {
    expect(allowlist.match('DELETE', '/v1/me')).toEqual({ kind: 'method_not_allowed', allow: expect.arrayContaining(['GET']) });
  });

  it('never admits an operation whose only principals are ORG or STF', () => {
    for (const r of allowlist.routes) {
      const tags = r.route.principals.flat().map((t) => t.tag);
      expect(
        tags.some((t) => ['USR', 'PUB', 'LNK', 'DRV'].includes(t)),
        r.opId,
      ).toBe(true);
    }
    const admin = Object.keys(OPERATIONS).filter((id) => id.startsWith('admin.'));
    expect(allowlist.routes.some((r) => admin.includes(r.opId))).toBe(false);
  });
});

describe('isCanonicalPath', () => {
  it.each([
    ['/v1/me', true],
    ['/v1/public/providers/reza-auto', true],
    ['/v1/public/providers/%D8%B1%D8%B6%D8%A7', true],
    ['/v1/me/../admin', false],
    ['/v1/me/./x', false],
    ['/v1/me//x', false],
    ['/v1/me/%2e%2e/admin', false],
    ['/v1/me%2Fvehicles', false],
    ['/v1/me%5cvehicles', false],
    ['/v1/me\\x', false],
    ['/v1/mé', false],
    ['/v1/me/', false],
  ])('%s → %s', (path, ok) => {
    expect(isCanonicalPath(path)).toBe(ok);
  });
});
