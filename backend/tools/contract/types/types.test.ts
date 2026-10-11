import { describe, expect, it } from 'vitest';
import { SchemaBuilder } from './json-schema.js';
import { parseTypeDefs, parseTypeExpr } from './parser.js';

const defs = parseTypeDefs(
  [
    'type Meta = { id: Id; created_at: DateTime; updated_at: DateTime; version: Int<1,2147483647> }',
    "type Status = 'active'|'inactive'",
    "  |'archived'",
    'type ThingWrite = { name: Str<1,60>; brand_node_id: NodeId<vehicle_brand|vehicle_model>; vin?: Vin;',
    '  shared_with_id?: Id;              // C: required when shared',
    '  tags?: Set<Str<1,20>,5> }',
    "type Thing = Meta & Omit<ThingWrite,'vin'> & { status: Status; owner: Ref<'user'|'organization'>; parent: Thing2 | null }",
    'type Thing2 = { id: Id }',
    'type Page<T> = { items: T[]; next_cursor: Cursor | null }',
    "type Headers = { 'Content-Type': string; pointer: string /* RFC 6901 */ }",
  ].join('\n'),
);

const b = new SchemaBuilder(defs, '#/$defs/');

describe('parseTypeDefs', () => {
  it('parses definitions, multi-line unions, comments and quoted names', () => {
    expect(defs.map((d) => d.name)).toEqual(['Meta', 'Status', 'ThingWrite', 'Thing', 'Thing2', 'Page', 'Headers']);
    expect(defs.find((d) => d.name === 'Page')!.params).toEqual(['T']);
    const write = defs.find((d) => d.name === 'ThingWrite')!.type;
    expect(write.k === 'obj' && write.fields.find((f) => f.name === 'shared_with_id')!.comment).toBe('C: required when shared');
  });

  it('rejects malformed input', () => {
    expect(() => parseTypeExpr('{ a: }')).toThrow();
    expect(() => parseTypeExpr("'open")).toThrow(/unterminated/);
  });
});

describe('SchemaBuilder', () => {
  it('turns literal unions into enums', () => {
    expect(b.definition('Status')).toEqual({ type: 'string', enum: ['active', 'inactive', 'archived'] });
  });

  it('flattens intersections and Omit into one closed object', () => {
    const s = b.definition('Thing') as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(s.properties)).toEqual([
      'id',
      'created_at',
      'updated_at',
      'version',
      'name',
      'brand_node_id',
      'shared_with_id',
      'tags',
      'status',
      'owner',
      'parent',
    ]);
    expect(s.additionalProperties).toBe(false);
    expect(s.required).not.toContain('shared_with_id');
    expect(s.properties.status).toEqual({ $ref: '#/$defs/Status' });
    expect(s.properties.parent).toEqual({ anyOf: [{ $ref: '#/$defs/Thing2' }, { type: 'null' }] });
    expect(s.properties.shared_with_id).toMatchObject({ 'x-conditional': 'required when shared' });
    expect(s.properties.brand_node_id).toMatchObject({ 'x-node-type': ['vehicle_brand', 'vehicle_model'] });
  });

  it('instantiates generics and Partial at use', () => {
    const page = b.expression(parseTypeExpr('Page<Thing2>'));
    expect(page).toMatchObject({ type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/Thing2' } } } });
    const partial = b.expression(parseTypeExpr('Partial<ThingWrite>')) as { required?: string[] };
    expect(partial.required).toBeUndefined();
  });

  it('builds the §3.1 primitives', () => {
    expect(b.expression(parseTypeExpr('Str<2,5>'))).toEqual({ type: 'string', minLength: 2, maxLength: 5, pattern: '^[^\\r\\n]*$' });
    expect(b.expression(parseTypeExpr('Set<Id,3>'))).toMatchObject({ type: 'array', maxItems: 3, uniqueItems: true });
    expect(b.expression(parseTypeExpr('Token<ri>'))).toEqual({ type: 'string', pattern: '^cp_ri_[A-Za-z0-9_-]{43}$' });
  });

  it('resolves indexed access, including on Ref<>', () => {
    expect(b.expression(parseTypeExpr("Thing['status']"))).toEqual({ $ref: '#/$defs/Status' });
    expect(b.expression(parseTypeExpr("Ref<'a'|'b'>['type']"))).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('reports unknown type names', () => {
    expect(() => b.expression(parseTypeExpr('Nope'))).toThrow(/unknown type Nope/);
    expect(b.unresolved.has('Nope')).toBe(true);
  });
});
