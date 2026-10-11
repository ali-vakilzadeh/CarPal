import { describe, expect, it } from 'vitest';
import {
  expandPath,
  hostFor,
  parseEmits,
  parseErrors,
  parseOperations,
  parseQuery,
  parseTag,
  securityAlternatives,
  splitLineComment,
  tokenizeSec,
  type AliasTable,
} from './parse-operations.js';

const aliases: AliasTable = {
  expansions: new Map([
    ['me', ['/v1/me']],
    ['org', ['/v1/orgs/{org_id}']],
    ['flt', ['/v1/orgs/{org_id}/fleet']],
    ['adm', ['/v1/admin']],
    ['V', ['{me}/vehicles', '{flt}/vehicles']],
    ['RQ', ['{me}', '{org}']],
  ]),
};

describe('expandPath', () => {
  it('expands nested aliases and keeps path parameters', () => {
    expect(expandPath('{V}/{vehicle_id}', aliases)).toEqual([
      '/v1/me/vehicles/{vehicle_id}',
      '/v1/orgs/{org_id}/fleet/vehicles/{vehicle_id}',
    ]);
    expect(expandPath('{RQ}/inquiries', aliases)).toEqual(['/v1/me/inquiries', '/v1/orgs/{org_id}/inquiries']);
    expect(expandPath('/v1/media/{media_id}', aliases)).toEqual(['/v1/media/{media_id}']);
  });
});

describe('hostFor', () => {
  it('routes OAuth, discovery and /v1/auth to the auth server, {adm} to admin-api', () => {
    expect(hostFor('/oauth/token')).toBe('auth');
    expect(hostFor('/.well-known/jwks.json')).toBe('auth');
    expect(hostFor('/v1/auth/signup')).toBe('auth');
    expect(hostFor('{adm}/users')).toBe('admin-api');
    expect(hostFor('<UploadTicket.url>')).toBe('storage');
    expect(hostFor('{me}/vehicles')).toBe('api');
  });
});

describe('sec tags', () => {
  it('parses arguments and qualifiers', () => {
    expect(parseTag('ORG(P*, FC)', 'x')).toEqual({ tag: 'ORG', args: ['P*', 'FC'] });
    expect(parseTag('ORG(FC: fleet_driver only)', 'x')).toEqual({ tag: 'ORG', args: ['FC'], qualifier: 'fleet_driver only' });
    expect(parseTag('ETAG(if exists)', 'x')).toEqual({ tag: 'ETAG', args: [], qualifier: 'if exists' });
    expect(parseTag('ORG(by target)', 'x')).toEqual({ tag: 'ORG', args: [], qualifier: 'by target' });
    expect(parseTag('4EYES', 'x')).toEqual({ tag: '4EYES', args: [] });
    expect(() => parseTag('NOPE', 'x')).toThrow(/unknown sec tag/);
  });

  it('splits "A | B rest" into two principals and shared tags', () => {
    const tokens = tokenizeSec('USR | ORG(F*) DRV IDEM RL(ai.user)', 'x')!;
    const { alternatives, shared } = securityAlternatives(tokens, 'x');
    expect(alternatives.map((a) => a.map((t) => t.tag))).toEqual([['USR'], ['ORG', 'DRV']]);
    expect(shared.map((t) => t.tag)).toEqual(['IDEM', 'RL']);
  });

  it('treats prose as no tags', () => {
    expect(tokenizeSec('signed URL only (no Authorization header)', 'x')).toBeNull();
  });
});

describe('field parsers', () => {
  it('parses query parameters with generic types and defaults', () => {
    expect(parseQuery("status?: VehicleStatus, sort?: 'a'|'b'='a', limit?: Int<1,50>=20, cursor?", 'x')).toEqual([
      { name: 'status', optional: true, type: 'VehicleStatus' },
      { name: 'sort', optional: true, type: "'a'|'b'", default: "'a'" },
      { name: 'limit', optional: true, type: 'Int<1,50>', default: '20' },
      { name: 'cursor', optional: true, type: null },
    ]);
  });

  it('parses errors with details and events with notes', () => {
    expect(parseErrors('409 VEHICLE_LIMIT_REACHED, 422 VALIDATION_FAILED(type_not_allowed, other)', 'x')).toEqual([
      { status: 409, code: 'VEHICLE_LIMIT_REACHED' },
      { status: 422, code: 'VALIDATION_FAILED', detail: 'type_not_allowed, other' },
    ]);
    expect(parseEmits('review.created, review.approval.requested (Path 2)', 'x')).toEqual([
      { event: 'review.created' },
      { event: 'review.approval.requested', note: 'Path 2' },
    ]);
    expect(parseEmits('(none; consent changes are audited)', 'x')).toEqual([]);
  });

  it('splits trailing comments but not URLs or quoted text', () => {
    expect(splitLineComment('in:   { url: Url }   // host must be allowlisted')).toEqual({
      code: 'in:   { url: Url }',
      comment: 'host must be allowlisted',
    });
    expect(splitLineComment("x: 'https://a//b'")).toEqual({ code: "x: 'https://a//b'" });
  });
});

describe('parseOperations', () => {
  const doc = [
    '## 0.3 Path aliases',
    '',
    '| Alias | Expands to | Path rule |',
    '|---|---|---|',
    '| `{me}` | `/v1/me` | own |',
    '| `{flt}` | `/v1/orgs/{org_id}/fleet` | fleet |',
    '| `{V}` | `{me}/vehicles` **or** `{flt}/vehicles` | both |',
    '| `{id}`, `{x_id}` | Path parameter of type `Id` | x |',
    '',
    '# 12. Vehicles — module `vehicle` (WP5)',
    '## 12.2 Operations',
    '#### vehicles.create',
    'Adds a vehicle.',
    '```',
    'POST {V} -> 201 Vehicle',
    'in:   VehicleWrite   // C: note',
    'sec:  USR | ORG(FC) IDEM ENT(max_vehicles)',
    'err:  409 VEHICLE_LIMIT_REACHED',
    'emit: vehicle.created',
    '```',
  ].join('\n');

  it('builds one route per prefix with its own principal', () => {
    const [op] = parseOperations(doc);
    expect(op).toMatchObject({
      opId: 'vehicles.create',
      module: 'vehicle',
      section: '12.2',
      inputType: 'VehicleWrite',
      inputEncoding: 'json',
      inputNote: 'C: note',
      successStatus: 201,
      responseType: 'Vehicle',
      line: 12,
    });
    expect(op!.routes.map((r) => [r.scope, r.path, r.security.principals[0]![0]!.tag])).toEqual([
      ['me', '/v1/me/vehicles', 'USR'],
      ['fleet', '/v1/orgs/{org_id}/fleet/vehicles', 'ORG'],
    ]);
    expect(op!.routes[1]!.pathParams).toEqual(['org_id']);
  });
});
