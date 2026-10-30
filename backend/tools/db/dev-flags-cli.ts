// pnpm dev:flags list | pnpm dev:flags set <key|preset>… on|off
// Development only (CARPAL_ENV=dev); see dev-flags.ts.
import { loadDbConfig } from './config.js';
import { assertDevEnvironment, listFlags, parseFlagArgs, setFlags } from './dev-flags.js';
import { connect } from './install.js';

async function main(): Promise<void> {
  const cfg = loadDbConfig();
  assertDevEnvironment(cfg.env);
  const command = parseFlagArgs(process.argv.slice(2));
  const db = await connect(cfg, { database: cfg.dbName });
  try {
    const flags = command.kind === 'list' ? await listFlags(db) : await setFlags(db, command.keys, command.enabled);
    for (const f of flags) console.log(`${f.enabled ? 'on ' : 'off'}  ${f.key}`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
