import { describe, expect, it } from 'vitest';
import { assertDev, DEV_STAFF, MINIMUM, parseSpec, parseStaffArgs, shortfall } from './staff.js';

describe('staff tool (backend S12, admin console OQ-10 / BR-05)', () => {
  it('parses the commands', () => {
    expect(parseStaffArgs(['bootstrap'])).toEqual({ kind: 'bootstrap' });
    expect(parseStaffArgs(['bootstrap', '--file', '/carpal/config/staff-bootstrap.json'])).toEqual({
      kind: 'bootstrap',
      file: '/carpal/config/staff-bootstrap.json',
    });
    expect(parseStaffArgs(['create', '--email', 'a@b.test', '--name', 'Ann', '--roles', 'adm, crv'])).toEqual({
      kind: 'create',
      spec: { email: 'a@b.test', name: 'Ann', roles: ['ADM', 'CRV'] },
    });
    expect(parseStaffArgs(['list'])).toEqual({ kind: 'list' });
    expect(parseStaffArgs(['break-glass', '--email', ' Adm1@Staff.Test ', '--reason', 'lost key, one other ADM'])).toEqual({
      kind: 'break-glass',
      email: 'adm1@staff.test',
      reason: 'lost key, one other ADM',
    });
    expect(() => parseStaffArgs(['break-glass', '--email', 'adm1@staff.test'])).toThrow(/--reason/);
    expect(() => parseStaffArgs(['break-glass', '--email', 'not-an-email', '--reason', 'lost key'])).toThrow(/--email/);
    expect(() => parseStaffArgs(['break-glass', '--email', 'a@b.test', '--reason', 'x'])).toThrow(/3-500/);
    expect(() => parseStaffArgs([])).toThrow(/Usage/);
    expect(() => parseStaffArgs(['bootstrap', '--force', 'yes'])).toThrow(/Unknown option --force/);
    expect(() => parseStaffArgs(['create', '--email'])).toThrow(/pairs/);
  });

  it('validates a spec: roles, unique emails, lower-cased addresses', () => {
    const specs = parseSpec([{ email: ' Ops@Example.COM ', name: 'Ops Lead', roles: ['ADM', 'ADM', 'CRV'] }], 'prod');
    expect(specs).toEqual([{ email: 'ops@example.com', name: 'Ops Lead', roles: ['ADM', 'CRV'] }]);
    expect(() => parseSpec([{ email: 'x@y.test', name: 'X Y', roles: ['ROOT'] }], 'dev')).toThrow(/Invalid staff spec/);
    expect(() => parseSpec([{ email: 'x@y.test', name: 'X Y', roles: [] }], 'dev')).toThrow(/Invalid staff spec/);
    expect(() =>
      parseSpec(
        [
          { email: 'x@y.test', name: 'X Y', roles: ['MOD'] },
          { email: 'X@y.test', name: 'X Z', roles: ['CRV'] },
        ],
        'dev',
      ),
    ).toThrow(/listed twice/);
    expect(() => parseSpec([], 'dev')).toThrow(/Invalid staff spec/);
    expect(() => parseSpec({ email: 'x@y.test' }, 'dev')).toThrow(/Invalid staff spec/);
  });

  it('refuses passwords in a spec outside dev', () => {
    const withPassword = [{ email: 'x@y.test', name: 'X Y', roles: ['ADM'], password: 'a-long-enough-password' }];
    expect(parseSpec(withPassword, 'dev')[0]!.password).toBe('a-long-enough-password');
    expect(() => parseSpec(withPassword, 'staging')).toThrow(/refused outside dev/);
    expect(() => parseSpec([{ email: 'x@y.test', name: 'X Y', roles: ['ADM'], password: 'short' }], 'dev')).toThrow();
  });

  it('reports the pilot minimum: two ADM, one MOD, one CRV (a person may hold several roles)', () => {
    expect(MINIMUM).toEqual({ ADM: 2, MOD: 1, CRV: 1, SUP: 0 });
    expect(shortfall(DEV_STAFF)).toEqual([]);
    expect(shortfall([{ roles: ['ADM', 'MOD', 'CRV'] }])).toEqual(['ADM: 1 of 2']);
    expect(shortfall([{ roles: ['SUP'] }])).toEqual(['ADM: 0 of 2', 'MOD: 0 of 1', 'CRV: 0 of 1']);
  });

  it('keeps the development accounts and create in dev only', () => {
    expect(DEV_STAFF.map((s) => s.roles.join(','))).toEqual(['ADM', 'ADM', 'MOD', 'CRV', 'SUP']);
    expect(() => assertDev('dev', 'dev:staff create')).not.toThrow();
    expect(() => assertDev('prod', 'dev:staff create')).toThrow(/only runs with CARPAL_ENV=dev/);
  });
});
