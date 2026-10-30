// Development-only feature flag switch (pwa DI-18): the community and Q&A
// flags are seeded off (Docs/43, Should-have) and the only real way to change
// a flag is admin.flag_update (staff aal3 with a device-bound passkey), which
// local development and the PWA E2E cannot use. This tool writes
// admin.feature_flags of the dev environment directly and publishes
// feature_flag.changed, so a running backend drops its flag cache at once
// (FlagCacheListener; otherwise within CARPAL_FLAG_REFRESH_MS). It refuses to
// run unless CARPAL_ENV=dev.
import type pg from 'pg';
import type { CarpalEnv } from './config.js';

/** Named groups of flags. */
export const FLAG_PRESETS: Readonly<Record<string, readonly string[]>> = {
  community: ['community.feed.enabled', 'community.comments.enabled', 'qna.enabled'],
};

export type FlagCommand = { kind: 'list' } | { kind: 'set'; keys: string[]; enabled: boolean };

const KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** `list` | `set <key|preset>… on|off`. */
export function parseFlagArgs(argv: readonly string[]): FlagCommand {
  const [command = 'list', ...rest] = argv;
  if (command === 'list' && rest.length === 0) return { kind: 'list' };
  if (command === 'set' && rest.length >= 2) {
    const state = rest.at(-1)!;
    if (state !== 'on' && state !== 'off') throw new Error(`The last argument must be on or off, got "${state}".`);
    const keys = rest.slice(0, -1).flatMap((k) => FLAG_PRESETS[k] ?? [k]);
    const bad = keys.filter((k) => !KEY.test(k));
    if (bad.length) throw new Error(`Not a flag key: ${bad.join(', ')}`);
    return { kind: 'set', keys: [...new Set(keys)], enabled: state === 'on' };
  }
  throw new Error('Usage: pnpm dev:flags list | pnpm dev:flags set <key|preset>… on|off (presets: community)');
}

export function assertDevEnvironment(env: CarpalEnv): void {
  if (env !== 'dev') throw new Error(`dev:flags only runs with CARPAL_ENV=dev (this is ${env}); use admin.flag_update elsewhere.`);
}

export interface FlagState {
  key: string;
  enabled: boolean;
}

type Queryable = Pick<pg.Client, 'query'>;

export async function listFlags(db: Queryable): Promise<FlagState[]> {
  const r = await db.query<FlagState>(
    `SELECT key, enabled FROM admin.feature_flags WHERE environment = 'dev' AND deleted_at IS NULL ORDER BY key`,
  );
  return r.rows;
}

/** Sets the flags in one transaction; every key must exist for the dev environment. */
export async function setFlags(db: Queryable, keys: readonly string[], enabled: boolean): Promise<FlagState[]> {
  await db.query('BEGIN');
  try {
    const found = await db.query<{ id: string; key: string; enabled: boolean }>(
      `SELECT id, key, enabled FROM admin.feature_flags
        WHERE environment = 'dev' AND deleted_at IS NULL AND key = ANY($1::text[]) FOR UPDATE`,
      [keys],
    );
    const missing = keys.filter((k) => !found.rows.some((r) => r.key === k));
    if (missing.length) throw new Error(`Unknown flag for dev: ${missing.join(', ')} (pnpm dev:flags list)`);
    for (const row of found.rows) {
      if (row.enabled === enabled) continue;
      await db.query(`UPDATE admin.feature_flags SET enabled = $1, updated_at = now() WHERE id = $2`, [enabled, row.id]);
      await db.query(`SELECT core.publish_event('feature_flag.changed', 'feature_flag', $1::uuid, $2::jsonb, 1)`, [
        row.id,
        JSON.stringify({ key: row.key, enabled }),
      ]);
    }
    await db.query('COMMIT');
    return found.rows.map((r) => ({ key: r.key, enabled })).sort((a, b) => a.key.localeCompare(b.key));
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
