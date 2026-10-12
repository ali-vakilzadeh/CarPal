import { describe, expect, it } from 'vitest';
import { ApiError } from '#libs/contract/index.js';
import {
  ContractValidator,
  normalizeInput,
  parseClientHeader,
  parseStrictJson,
  parseTimezone,
  ProtocolError,
  RouteTable,
  toProblem,
  versionBelow,
} from './index.js';

const json = (s: string) => parseStrictJson(Buffer.from(s, 'utf8'));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).code;
  }
  return 'OK';
};

describe('parseStrictJson (SEC-IN-2)', () => {
  it('parses plain JSON', () => {
    expect(json(' {"a":[1,-2.5,true,null,"x\\u00e9\\n"],"b":{}} ')).toEqual({ a: [1, -2.5, true, null, 'xé\n'], b: {} });
  });
  it('rejects duplicates, forbidden keys, exponents, unsafe integers, trailing data and control characters', () => {
    for (const s of [
      '{"a":1,"a":2}',
      '{"__proto__":1}',
      '{"prototype":1}',
      '[1e5]',
      '[1E5]',
      '[9007199254740993]',
      '{} x',
      '["a\tb"]',
      '[01]',
      "{'a':1}",
      '{"a":1,}',
      '[.5]',
    ]) {
      expect(
        code(() => json(s)),
        s,
      ).toBe('MALFORMED_REQUEST');
    }
  });
  it('limits depth to 8 and keys to 1,000 (413)', () => {
    expect(code(() => json('['.repeat(8) + ']'.repeat(8)))).toBe('OK');
    expect(code(() => json('['.repeat(9) + ']'.repeat(9)))).toBe('PAYLOAD_TOO_LARGE');
    expect(code(() => json(JSON.stringify(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, i])))))).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });
  it('requires strict UTF-8 without BOM', () => {
    expect(code(() => parseStrictJson(Buffer.from([0x22, 0xff, 0x22])))).toBe('MALFORMED_REQUEST');
    expect(code(() => parseStrictJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])))).toBe('MALFORMED_REQUEST');
  });
});

describe('normalizeInput (SEC-IN-4)', () => {
  const ZWNJ = String.fromCharCode(0x200c);
  const LRO = String.fromCharCode(0x202d);
  it('trims, NFC-normalizes, converts digits in numeric strings and keeps ZWNJ', () => {
    const { value, errors } = normalizeInput({
      a: '  é ',
      phone: '+۹۸۹۱۲۳۴۵۶۷۸۹',
      code: '۱۲۳۴۵۶',
      text: `می${ZWNJ}خواهم ۲ تا`,
      password: '  pass ',
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({ a: 'é', phone: '+989123456789', code: '123456', text: `می${ZWNJ}خواهم ۲ تا`, password: '  pass ' });
  });
  it('reports forbidden characters with JSON pointers', () => {
    const lone = String.fromCharCode(0xd800);
    const { errors } = normalizeInput({
      list: ['ok', `x${LRO}`],
      'a/b': 'bell\u0007',
      ok: 'line\nbreak\ttab',
      bad: `half ${lone}`,
      nonchar: String.fromCharCode(0xfffe),
    });
    expect(errors).toEqual([
      { pointer: '/list/1', code: 'forbidden_character' },
      { pointer: '/a~1b', code: 'forbidden_character' },
      { pointer: '/bad', code: 'forbidden_character' },
      { pointer: '/nonchar', code: 'forbidden_character' },
    ]);
  });
});

describe('RouteTable (L1 router)', () => {
  const api = new RouteTable('api');
  const admin = new RouteTable('admin-api');
  const id = '0190b2d4-7a1c-7c3e-9f00-123456789abc';

  it('matches contract routes with typed path parameters', () => {
    const m = api.match('GET', `/v1/jobs/${id}`);
    expect(m.kind === 'match' && m.entry.op.opId).toBe('jobs.get');
    expect(m.kind === 'match' && m.params).toEqual({ job_id: id });
    const fleet = api.match('GET', `/v1/orgs/${id}/fleet/vehicles/${id}`);
    expect(fleet.kind === 'match' && [fleet.entry.op.opId, fleet.entry.route.scope]).toEqual(['vehicles.get', 'fleet']);
  });

  it('fails closed: unknown paths, invalid ids, other hosts, dot segments, encoded slashes', () => {
    for (const p of [
      '/v1/jobs',
      '/v1/jobs/123',
      `/v1/jobs/${id}/`,
      '/v1/admin/flags',
      `/v1/jobs/${id.toUpperCase()}`,
      '/v1/./health',
      '/v1/health%2F',
      '/v1\\health',
    ]) {
      expect(api.match('GET', p).kind, p).toBe('not_found');
    }
    expect(admin.match('GET', '/v1/health').kind).toBe('not_found');
  });

  it('405 lists the allowed methods', () => {
    expect(api.match('DELETE', `/v1/jobs/${id}`)).toEqual({ kind: 'method_not_allowed', allow: ['GET'] });
    expect(api.match('HEAD', '/v1/health')).toEqual({ kind: 'method_not_allowed', allow: ['GET'] });
  });
});

describe('ContractValidator', () => {
  const v = new ContractValidator();
  const errs = (fn: () => void) => {
    try {
      fn();
      return [];
    } catch (e) {
      return (e as ApiError).errors;
    }
  };

  it('reports union failures by the closest branch only', () => {
    // OrgUpdate.legal_name: Str<2,160> | null → a one-letter name is too short, not "type".
    expect(errs(() => v.validateBody('org.update', 200, { legal_name: 'x' }))).toEqual([
      { pointer: '/legal_name', code: 'too_short', limit: '2' },
    ]);
    expect(errs(() => v.validateBody('org.update', 200, { legal_name: 5 }))).toEqual([{ pointer: '/legal_name', code: 'type' }]);
    expect(errs(() => v.validateBody('org.update', 200, { legal_name: null }))).toEqual([]);
  });

  it('coerces and defaults query parameters', () => {
    expect(v.parseQuery('vehicles.list', 200, 'has_open_issues=true&limit=5')).toEqual({ has_open_issues: true, limit: 5 });
    expect(v.parseQuery('vehicles.list', 200, '')).toEqual({ limit: 20 });
    expect(() => v.parseQuery('vehicles.list', 200, 'status=a&status=b')).toThrow(expect.objectContaining({ code: 'UNKNOWN_QUERY_PARAM' }));
  });

  it('collects NodeId<type> references of a valid body for the taxonomy check (x-node-type)', () => {
    const brand = '0190a000-0000-7000-8000-000000000001';
    const model = '0190a000-0000-7000-8000-000000000002';
    const refs = v.validateBody('provider.coverage_create', 200, {
      items: [{ brand_node_id: brand, model_node_id: model, coverage_level: 'specialist' }],
    });
    expect(refs).toEqual([
      { pointer: '/items/0/brand_node_id', id: brand, types: ['vehicle_brand'] },
      { pointer: '/items/0/model_node_id', id: model, types: ['vehicle_model'] },
    ]);
    // NodeId<a|b> carries every allowed type.
    expect(
      v.validateBody('provider.service_category_create', 201, {
        taxonomy_node_id: brand,
        experience_level: 'advanced',
        visibility: 'public',
      }),
    ).toEqual([{ pointer: '/taxonomy_node_id', id: brand, types: ['service_system', 'service_task'] }]);
    expect(v.validateBody('health.get', 200, undefined)).toEqual([]);
  });

  it('checks responses against the contract', () => {
    expect(v.checkResponse('health.get', 200, 200, { status: 'ok' })).toEqual([]);
    expect(v.checkResponse('health.get', 200, 200, { status: 'ok', version: '1' })).toEqual([
      { pointer: '/version', code: 'unknown_field' },
    ]);
  });
});

describe('ProtocolError', () => {
  it('carries an RFC 6749 body and its own status, with no-store', () => {
    const e = new ProtocolError(400, 'invalid_grant', { description: 'code already used' });
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ error: 'invalid_grant', error_description: 'code already used' });
    expect(e.headers['cache-control']).toBe('no-store');
    expect(new ProtocolError(401, 'invalid_client').body).toEqual({ error: 'invalid_client' });
  });
});

describe('headers', () => {
  it('parses CarPal-Client and enforces minimum versions', () => {
    expect(parseClientHeader('cp-mobile/1.4.2 (android 14)', {})).toEqual({
      clientId: 'cp-mobile',
      version: '1.4.2',
      os: 'android',
      osVersion: '14',
    });
    expect(code(() => parseClientHeader('cp-mobile/1.4.2 (android 14)', { 'cp-mobile': '1.10.0' }))).toBe('CLIENT_UPGRADE_REQUIRED');
    expect(code(() => parseClientHeader('Mozilla/5.0', {}))).toBe('MALFORMED_REQUEST');
    expect(versionBelow('1.9.9', '1.10.0')).toBe(true);
    expect(versionBelow('2.0.0', '1.10.0')).toBe(false);
  });
  it('accepts IANA time zones only', () => {
    expect(parseTimezone('Asia/Tehran')).toBe('Asia/Tehran');
    expect(code(() => parseTimezone('Mars/Olympus'))).toBe('MALFORMED_REQUEST');
  });
  it('renders problems without internal detail', () => {
    const p = toProblem(new ApiError('INTERNAL', { detail: 'SELECT * FROM secrets' }), 'rid', 'en');
    expect(JSON.stringify(p)).not.toContain('SELECT');
    expect(p).toEqual({
      type: 'https://docs.carpal.app/errors/internal',
      title: 'Something went wrong. Please try again.',
      status: 500,
      code: 'INTERNAL',
      request_id: 'rid',
    });
    expect(toProblem(new ApiError('RATE_LIMITED', { retryAfterMs: 1500 }), 'r', 'en').retry_after_ms).toBe(1500);
  });
  it('renders the optional Problem members of DI-10 (requirements, consent_type, entitlement_key)', async () => {
    const p = toProblem(
      new ApiError('PUBLISH_REQUIREMENTS_UNMET', { extensions: { requirements: ['active_location', 'supported_brand'] } }),
      '0190a0a0-0000-7000-8000-000000000000',
      'en',
    );
    expect(p.requirements).toEqual(['active_location', 'supported_brand']);
    expect(toProblem(new ApiError('CONSENT_REQUIRED', { extensions: { consent_type: 'vehicle_data_sharing' } }), 'r', 'en')).toMatchObject({
      consent_type: 'vehicle_data_sharing',
    });
    const { createContractAjv, loadSchemas } = await import('#libs/contract/index.js');
    const validate = createContractAjv().getSchema(`${loadSchemas().root.$id}#/$defs/Problem`)!;
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('contract invariants the pipeline relies on', () => {
  it('RSN operations require `reason` in their input schema (except the bodyless DELETEs of DI-09)', async () => {
    const { loadRegistry, loadSchemas } = await import('#libs/contract/index.js');
    const v = new ContractValidator();
    const missing = loadRegistry()
      .operations.filter((o) => o.routes.some((r) => r.security.tags.some((t) => t.tag === 'RSN')))
      .filter((o) => {
        if (!loadSchemas().operations[o.opId]?.input) return true;
        try {
          v.validateBody(o.opId, o.successStatus, {});
          return true;
        } catch (e) {
          return !(e as ApiError).errors?.some((x) => x.pointer === '/reason' && x.code === 'required');
        }
      })
      .map((o) => o.opId);
    expect(missing.sort()).toEqual(['admin.platform_role_revoke', 'admin.synonym_delete']);
  });
});
