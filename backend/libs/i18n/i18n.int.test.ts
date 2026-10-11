// The JS search normalization must equal core.normalize_search_text() in the database.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#libs/config/index.js';
import { normalizeSearchText } from './index.js';

const config = loadConfig();
const client = new pg.Client({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: 'carpal_api',
  password: config.db.passwords.carpal_api,
});
beforeAll(() => client.connect());
afterAll(() => client.end());

const ch = (n: number): string => String.fromCodePoint(n);
const spaces = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0x180e, 0x200b,
  0xfeff,
];
const corpus = [
  '  لنت  ترمز‌ها ',
  'يك كيلو ى',
  'تـــعمیرگاه',
  'Brake PADS ۱۲۳ ٤٥٦',
  'Citroën ÉCLAIR Ñandú',
  'é café', // decomposed → NFC
  'İstanbul ǅ ß',
  'lent tormoz',
  ...spaces.map((s) => `a${ch(s)}b${ch(s)}${ch(s)}c`),
];

describe('normalizeSearchText vs core.normalize_search_text', () => {
  it('produces identical output for the corpus', async () => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT core.normalize_search_text(t) AS n FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY i',
      [corpus],
    );
    const mismatches = corpus
      .map((t, i) => ({
        input: [...t].map((c) => c.codePointAt(0)!.toString(16)).join(' '),
        db: rows[i]!.n,
        js: normalizeSearchText(t, { dbLocale: config.db.locale }),
      }))
      .filter((r) => r.db !== r.js);
    expect(mismatches).toEqual([]);
  });
});
