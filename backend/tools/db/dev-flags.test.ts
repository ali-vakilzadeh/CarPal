import { describe, expect, it } from 'vitest';
import { assertDevEnvironment, parseFlagArgs, setFlags } from './dev-flags.js';

describe('dev:flags', () => {
  it('refuses to run outside the dev environment', () => {
    expect(() => assertDevEnvironment('dev')).not.toThrow();
    expect(() => assertDevEnvironment('staging')).toThrow(/CARPAL_ENV=dev/);
    expect(() => assertDevEnvironment('prod')).toThrow(/CARPAL_ENV=dev/);
  });

  it('parses list and set, expanding presets', () => {
    expect(parseFlagArgs([])).toEqual({ kind: 'list' });
    expect(parseFlagArgs(['list'])).toEqual({ kind: 'list' });
    expect(parseFlagArgs(['set', 'qna.enabled', 'off'])).toEqual({ kind: 'set', keys: ['qna.enabled'], enabled: false });
    expect(parseFlagArgs(['set', 'community', 'qna.enabled', 'on'])).toEqual({
      kind: 'set',
      keys: ['community.feed.enabled', 'community.comments.enabled', 'qna.enabled'],
      enabled: true,
    });
  });

  it('rejects malformed commands', () => {
    expect(() => parseFlagArgs(['set', 'qna.enabled'])).toThrow(/Usage/);
    expect(() => parseFlagArgs(['set', 'qna.enabled', 'yes'])).toThrow(/on or off/);
    expect(() => parseFlagArgs(['set', 'DROP TABLE', 'on'])).toThrow(/Not a flag key/);
    expect(() => parseFlagArgs(['delete', 'x.y'])).toThrow(/Usage/);
  });

  it('changes only flags whose state differs, publishes feature_flag.changed, and refuses unknown keys', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const rows = [
      { id: '00000000-0000-7000-8000-000000000001', key: 'qna.enabled', enabled: false },
      { id: '00000000-0000-7000-8000-000000000002', key: 'community.feed.enabled', enabled: true },
    ];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: sql.includes('FOR UPDATE') ? rows : [] };
      },
    } as never;
    const out = await setFlags(db, ['qna.enabled', 'community.feed.enabled'], true);
    expect(out).toEqual([
      { key: 'community.feed.enabled', enabled: true },
      { key: 'qna.enabled', enabled: true },
    ]);
    expect(calls.filter((c) => c.sql.startsWith('UPDATE'))).toHaveLength(1);
    expect(calls.filter((c) => c.sql.includes('publish_event'))).toHaveLength(1);
    expect(calls.at(-1)!.sql).toBe('COMMIT');

    calls.length = 0;
    await expect(setFlags(db, ['qna.enabled', 'nope.flag'], true)).rejects.toThrow(/Unknown flag for dev: nope.flag/);
    expect(calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });
});
