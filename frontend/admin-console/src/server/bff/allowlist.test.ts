// AC3.T7: the forwarder's allowlist is exactly the generated admin operation map (R-06), nothing more.
import { OPERATIONS } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { ADMIN_OPERATIONS, ADMIN_OPERATION_IDS } from '@/lib/api/generated';
import { AdminAllowlist, isCanonicalPath } from './allowlist';

const allowlist = new AdminAllowlist();
const sample = (path: string) => path.replace(/\{[a-z_]+\}/g, '0193a5b0-0000-7000-8000-00000000000a');

describe('admin allowlist (SEC-WEB-1, GD-07 amendment)', () => {
  it('holds every admin-api operation of the generated map and nothing else', () => {
    expect(allowlist.routes.map((r) => r.opId).sort()).toEqual([...ADMIN_OPERATION_IDS].sort());
    expect(allowlist.routes).toHaveLength(75);
    for (const r of allowlist.routes) expect(r.op.host).toBe('admin-api');
  });

  it('matches each admin operation by method and path, with its path parameters', () => {
    for (const id of ADMIN_OPERATION_IDS) {
      const op = ADMIN_OPERATIONS[id];
      const m = allowlist.match(op.method, sample(op.path));
      expect(m.kind, id).toBe('ok');
      if (m.kind === 'ok') {
        // Two operations can share a method and a path only if the map is wrong; the first match must be this one.
        expect(m.route.op.path).toBe(op.path);
        expect(Object.keys(m.params)).toEqual([...op.pathParams]);
      }
    }
  });

  it('prefers literal segments over parameters', () => {
    const m = allowlist.match('POST', '/v1/admin/users/search');
    expect(m.kind === 'ok' && m.route.opId).toBe('admin.users_search');
  });

  it('refuses consumer, business and auth-host routes and unknown admin paths', () => {
    expect(allowlist.match('GET', '/v1/me').kind).toBe('not_found');
    expect(allowlist.match('GET', '/v1/config/client').kind).toBe('not_found');
    expect(allowlist.match('GET', '/v1/orgs/x/members').kind).toBe('not_found');
    expect(allowlist.match('POST', '/v1/auth/signin').kind).toBe('not_found');
    expect(allowlist.match('GET', '/v1/admin/nothing-here').kind).toBe('not_found');
  });

  it('never admits a route of the full registry that is not on admin-api', () => {
    for (const [id, op] of Object.entries(OPERATIONS)) {
      for (const route of op.routes) {
        if (route.host === 'admin-api') continue;
        const m = allowlist.match(op.method, sample(route.path));
        expect(m.kind === 'ok' ? m.route.opId : null, id).toBeNull();
      }
    }
  });

  it('reports the allowed methods of a known path', () => {
    expect(allowlist.match('DELETE', '/v1/admin/me')).toEqual({ kind: 'method_not_allowed', allow: ['GET'] });
  });
});

describe('isCanonicalPath', () => {
  it.each([
    ['/v1/admin/me', true],
    ['/v1/admin/users/0193a5b0-0000-7000-8000-00000000000a', true],
    ['/v1/admin/flags/featured.enabled', true],
    ['/v1/admin/../me', false],
    ['/v1/admin/./me', false],
    ['/v1/admin//me', false],
    ['/v1/admin/%2e%2e/me', false],
    ['/v1/admin%2Fme', false],
    ['/v1/admin%5cme', false],
    ['/v1/admin\\me', false],
    ['/v1/admín', false],
    ['/v1/admin/me/', false],
  ])('%s → %s', (path, ok) => {
    expect(isCanonicalPath(path)).toBe(ok);
  });
});
