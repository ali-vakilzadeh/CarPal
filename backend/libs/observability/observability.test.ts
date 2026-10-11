import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, escapeLogValue, ipPrefix, resolveRequestId } from './index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination, base: { service: 'test' } }) };
}

const RLO = String.fromCharCode(0x202e);

describe('logger', () => {
  it('redacts secrets, tokens and personal data', () => {
    const { lines, logger } = capture();
    logger.info({ headers: { authorization: 'DPoP abc' }, body: { password: 'hunter2', vin: 'WVW', nested: { email: 'a@b.c' } } }, 'x');
    const line = JSON.stringify(lines[0]);
    expect(line).not.toMatch(/abc|hunter2|WVW|a@b\.c/);
    expect(line).toContain('[redacted]');
  });

  it('escapes CR/LF, controls and bidi overrides in fields and messages (SEC-LOG-2)', () => {
    const { lines, logger } = capture();
    logger.info({ route: '/v1/x\r\n{"level":"fatal"}' }, `msg\nforged ${RLO}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toBe('/v1/x\\u000d\\u000a{"level":"fatal"}');
    expect(lines[0]!.msg).toBe('msg\\u000aforged \\u202e');
    expect(escapeLogValue('a'.repeat(600)).length).toBe(513);
  });
});

describe('request ids', () => {
  it('echoes a UUID and replaces anything else', () => {
    expect(resolveRequestId('0190B2D4-7A1C-7C3E-9F00-123456789ABC')).toBe('0190b2d4-7a1c-7c3e-9f00-123456789abc');
    const replaced = resolveRequestId('abc\r\ninjected');
    expect(replaced).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});

describe('ipPrefix', () => {
  it('uses /24 for IPv4 and /56 for IPv6', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:abcd:12ff::1')).toBe('2001:0db8:abcd:1200::/56');
    expect(ipPrefix('nonsense')).toBe('unknown');
  });
});
