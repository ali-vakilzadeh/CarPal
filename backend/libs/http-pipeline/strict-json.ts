// Strict JSON parsing (40 SEC-IN-1/2): strict UTF-8 (no BOM), no duplicate
// keys, no __proto__/constructor/prototype keys at any depth, no exponent
// numbers, integers within the safe range, depth ≤ 8, ≤ 1,000 keys in total.
// Syntax errors are 400 MALFORMED_REQUEST; structural limits are 413.
import { ApiError } from '#libs/contract/index.js';

export const MAX_DEPTH = 8;
export const MAX_KEYS = 1_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Parser {
  i = 0;
  keys = 0;

  constructor(private readonly s: string) {}

  fail(what: string): never {
    throw new ApiError('MALFORMED_REQUEST', { detail: `invalid JSON at ${this.i}: ${what}` });
  }

  ws(): void {
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.i++;
      else return;
    }
  }

  value(depth: number): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.object(depth + 1);
    if (c === '[') return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    return this.fail('unexpected character');
  }

  literal<T>(word: string, v: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    return this.fail('unexpected literal');
  }

  depthCheck(depth: number): void {
    if (depth > MAX_DEPTH) throw new ApiError('PAYLOAD_TOO_LARGE', { detail: `JSON nesting deeper than ${MAX_DEPTH}` });
  }

  object(depth: number): Record<string, unknown> {
    this.depthCheck(depth);
    this.i++;
    // __proto__, constructor and prototype are rejected below, so plain objects are safe.
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('expected a key');
      const key = this.string();
      if (FORBIDDEN_KEYS.has(key)) this.fail(`forbidden key ${key}`);
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`duplicate key ${JSON.stringify(key).slice(0, 80)}`);
      if (++this.keys > MAX_KEYS) throw new ApiError('PAYLOAD_TOO_LARGE', { detail: `more than ${MAX_KEYS} keys` });
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected :');
      this.i++;
      out[key] = this.value(depth);
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') this.fail('expected , or }');
    }
  }

  array(depth: number): unknown[] {
    this.depthCheck(depth);
    this.i++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') this.fail('expected , or ]');
    }
  }

  string(): string {
    const start = ++this.i;
    let out = '';
    let chunk = start;
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (Number.isNaN(c)) this.fail('unterminated string');
      if (c === 0x22) {
        out += this.s.slice(chunk, this.i++);
        return out;
      }
      if (c < 0x20) this.fail('control character in string');
      if (c === 0x5c) {
        out += this.s.slice(chunk, this.i);
        const e = this.s[this.i + 1];
        this.i += 2;
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out += e;
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            this.fail('bad escape');
        }
        chunk = this.i;
        continue;
      }
      this.i++;
    }
  }

  number(): number {
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?/.exec(this.s.slice(this.i, this.i + 400));
    if (!m) return this.fail('bad number');
    const next = this.s[this.i + m[0].length];
    if (next === 'e' || next === 'E') this.fail('exponent numbers are not accepted');
    if (next !== undefined && next >= '0' && next <= '9') this.fail('bad number');
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!m[1] && !Number.isSafeInteger(n)) this.fail('integer out of range');
    if (!Number.isFinite(n)) this.fail('number out of range');
    return n;
  }
}

/** Decodes strict UTF-8 and parses one JSON value with the SEC-IN-2 rules. */
export function parseStrictJson(body: Buffer): unknown {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    throw new ApiError('MALFORMED_REQUEST', { detail: 'byte order mark not accepted' });
  }
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    throw new ApiError('MALFORMED_REQUEST', { detail: 'body is not valid UTF-8' });
  }
  const p = new Parser(text);
  const value = p.value(0);
  p.ws();
  if (p.i !== text.length) p.fail('trailing data');
  return value;
}
