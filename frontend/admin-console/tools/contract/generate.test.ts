import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { ADMIN_CONTRACT, ADMIN_OPERATIONS, ROLE_TABLE, type AdminInput, type AdminResponse } from '@/lib/api/generated';
import {
  API_READS,
  PATHS,
  contractProblems,
  generateFiles,
  selectOperations,
  sharedContractOf,
  staleFiles,
  type Registry,
} from './generate';

const registry = (): Registry => JSON.parse(readFileSync(PATHS.registry, 'utf8')) as Registry;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('admin contract generation (AC1.T2)', () => {
  it('src/lib/api/generated is up to date with the backend registry and the shared contract', () => {
    expect(contractProblems(registry())).toEqual([]);
  });

  it('selects the 93 admin-api operations of contract 1.4.0 (S17: notification templates, rules and staff notices) and no api reads (AC2: the api host refuses admin tokens)', () => {
    const ops = selectOperations(registry());
    expect([...ops.values()].filter((o) => o.plane === 'admin')).toHaveLength(93);
    expect(API_READS).toEqual([]);
    expect([...ops.values()].filter((o) => o.plane === 'api-read')).toHaveLength(0);
    expect(ADMIN_CONTRACT).toMatchObject({ version: '1.4.0', adminOperationCount: 93, apiReadCount: 0 });
    for (const op of ops.values()) if (op.plane === 'admin') expect(op.host).toBe('admin-api');
  });

  it('parses roles and the tags the console acts on', () => {
    expect(ADMIN_OPERATIONS['admin.users_search']).toMatchObject({
      method: 'POST',
      roles: ['ADM', 'MOD', 'SUP'],
      purpose: true,
      pii: true,
    });
    // 4EYES and AAL3 can be conditional (Docs/40 tag composition rules).
    expect(ADMIN_OPERATIONS['admin.flag_update'].fourEyes).toEqual(['kill switch off', 'featured.enabled on']);
    expect(ADMIN_OPERATIONS['admin.case_action'].aal3).toEqual(['suspend_account', 'apply_trust_penalty', 'merge_duplicate']);
    expect(ADMIN_OPERATIONS['admin.four_eyes_decide']).toMatchObject({
      roles: ['ADM', 'MOD'],
      roleQualifier: 'moderation changes only',
      aal3: true,
    });
    // Contract 1.3.0 (BR-04): every staff role may read itself.
    expect(ADMIN_OPERATIONS['admin.staff_me']).toMatchObject({ method: 'GET', path: '/v1/admin/me', roles: ['ADM', 'MOD', 'SUP', 'CRV'] });
  });

  it('builds the role table from the STF(...) sets', () => {
    expect(ROLE_TABLE.CRV).toContain('admin.review_approval_decide');
    expect(ROLE_TABLE.MOD).not.toContain('admin.audit_search');
    expect(ROLE_TABLE.ADM).toContain('admin.audit_search');
    for (const [role, ids] of Object.entries(ROLE_TABLE))
      for (const id of ids) expect((ADMIN_OPERATIONS[id].roles as readonly string[]).includes(role)).toBe(true);
  });

  it('fails the check when operations.json changes', () => {
    const changed = registry();
    const op = changed.operations.find((o) => o.opId === 'admin.flags_list')!;
    op.routes[0]!.security.principals = [[{ tag: 'STF', args: ['ADM', 'SUP'] }]];
    const out = mkdtempSync(join(tmpdir(), 'adm-contract-'));
    dirs.push(out);
    for (const [name, content] of generateFiles(registry())) writeFileSync(join(out, name), content);
    expect(staleFiles(generateFiles(changed), out)).toEqual(['operations.ts', 'roles.ts']);
    // A new Docs/40 version also fails: the shared contract and the expected version no longer match.
    const bumped = { ...registry(), contractVersion: '1.5.0', sourceSha256: '0'.repeat(64) };
    expect(contractProblems(bumped, { ...PATHS, out }).length).toBeGreaterThanOrEqual(2);
  });

  it('reads the CONTRACT constant of the shared package', () => {
    expect(sharedContractOf('export const CONTRACT = {"version":"1.2.0","sourceSha256":"ab"} as const;')).toEqual({
      version: '1.2.0',
      sourceSha256: 'ab',
    });
    expect(sharedContractOf('nothing here')).toBeNull();
  });

  it('types inputs and responses through @carpal/api-contracts', () => {
    expectTypeOf<AdminInput<'admin.exchange_rate_update'>>().toHaveProperty('per_usd');
    expectTypeOf<AdminResponse<'admin.flags_list'>>().not.toBeNever();
  });
});
