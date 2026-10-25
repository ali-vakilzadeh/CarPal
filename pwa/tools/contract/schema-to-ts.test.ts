import { describe, expect, it } from 'vitest';
import { docComment, hasTopLevelOperator, schemaToTs, type JsonSchema } from './schema-to-ts';

const opts = { refName: (ref: string) => ref.slice(ref.lastIndexOf('/') + 1) };
const ts = (s: JsonSchema) => schemaToTs(s, opts);

describe('schemaToTs', () => {
  it('maps scalars, const, enum and nullable types', () => {
    expect(ts({ type: 'string' })).toBe('string');
    expect(ts({ type: 'integer' })).toBe('number');
    expect(ts({ const: 'user_position' })).toBe('"user_position"');
    expect(ts({ enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(ts({ type: ['string', 'null'] })).toBe('string | null');
    expect(ts({ anyOf: [{ $ref: '#/$defs/Vehicle' }, { type: 'null' }] })).toBe('Vehicle | null');
  });

  it('maps objects with required and optional members and descriptions', () => {
    expect(
      ts({
        type: 'object',
        properties: { id: { type: 'string' }, 'odd-key': { type: 'boolean', description: 'note */ here' } },
        required: ['id'],
        additionalProperties: false,
      }),
    ).toBe('{\n  id: string;\n  /** note *\\/ here */\n  "odd-key"?: boolean;\n}');
  });

  it('maps maps, keyed maps and empty closed objects', () => {
    expect(ts({ type: 'object', additionalProperties: { type: 'number' } })).toBe('Record<string, number>');
    expect(ts({ type: 'object', propertyNames: { enum: ['fa', 'en'] }, additionalProperties: { type: 'string' } })).toBe(
      'Partial<Record<"fa" | "en", string>>',
    );
    expect(ts({ type: 'object', properties: {}, additionalProperties: false })).toBe('Record<string, never>');
  });

  it('parenthesizes unions inside arrays and intersections', () => {
    expect(ts({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('Array<"a" | "b">');
    expect(ts({ type: 'array', items: { $ref: '#/$defs/Id' } })).toBe('Id[]');
    expect(ts({ allOf: [{ $ref: '#/$defs/Meta' }, { anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }] }] })).toBe('Meta & (A | B)');
  });

  it('uses x-server-schema names and opens x-external documents', () => {
    expect(ts({ type: 'object', 'x-server-schema': 'FeedCard' })).toBe('FeedCard');
    expect(ts({ type: 'object', 'x-external': 'RFC 7517' })).toBe('Record<string, unknown>');
  });
});

describe('helpers', () => {
  it('finds top-level operators only', () => {
    expect(hasTopLevelOperator('{ a: string | null }')).toBe(false);
    expect(hasTopLevelOperator('"a|b"')).toBe(false);
    expect(hasTopLevelOperator('A | B')).toBe(true);
  });
  it('writes one-line doc comments', () => {
    expect(docComment('two\n lines', '  ')).toBe('  /** two lines */\n');
    expect(docComment('   ', '')).toBe('');
  });
});
