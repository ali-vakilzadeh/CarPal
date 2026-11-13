// pnpm staff:bootstrap [--file <spec.json>] | pnpm dev:staff create … | pnpm dev:staff list | pnpm staff:break-glass …
// See staff.ts. Connects as carpal_worker with the role passwords of the environment (backend/.env in dev; on a
// server deploy/staff-bootstrap.sh loads /carpal/config/backend.env first).
import { readFileSync } from 'node:fs';
import { loadConfig } from '#libs/config/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { Database } from '#libs/db/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import {
  assertDev,
  bootstrapStaff,
  breakGlassStaff,
  DEV_STAFF,
  listStaff,
  parseSpec,
  parseStaffArgs,
  shortfall,
  type StaffResult,
} from './staff.js';

function print(results: readonly StaffResult[]): void {
  for (const r of results)
    console.log(`${r.status === 'created' ? 'created' : 'exists '}  ${r.email}  ${r.roles.join(',') || '(no platform role)'}`);
  const created = results.filter((r) => r.password);
  if (created.length === 0) return;
  console.log('\nOne-time passwords (shown once; hand each to its owner over a separate channel):');
  for (const r of created) console.log(`  ${r.email}  ${r.password}`);
  console.log('\nFirst sign-in on the admin console: email + this password, then the code sent to the email, then a');
  console.log('security key or a passkey kept on that device only (synced passkeys are refused for staff, SEC-ADM-2).');
}

async function main(): Promise<void> {
  const command = parseStaffArgs(process.argv.slice(2));
  const config = loadConfig();
  const database = new Database(config, 'carpal_worker', { applicationName: 'carpal-staff-cli', max: 2 });
  const deps = { tx: new TxRunner(database), crypto: new CryptoServices(config.secrets.master), env: config.env };
  try {
    if (command.kind === 'list') {
      for (const s of await listStaff(deps)) console.log(`${s.email}  ${s.roles.join(',')}  passkeys: ${s.passkeys}`);
      return;
    }
    if (command.kind === 'break-glass') {
      const r = await breakGlassStaff(deps, command.email, command.reason);
      console.log(`break glass: ${r.email} (${r.roles.join(',')}): ${r.keys} security keys and ${r.codes} open recovery codes disabled.`);
      console.log('Audited as actor system (action staff.break_glass) with your reason.');
      console.log("The running backend now ends the account's sessions and emails the account and every other active");
      console.log('administrator (event staff.break_glass; if the backend is stopped, at its next start).');
      console.log('Next console sign-in: email + password, then the code sent to the email, then a new device-bound key.');
      console.log('The new key comes with a new sheet of recovery codes; the old sheet is void.');
      if (r.otherAdmins < 2) console.log(`Note: ${r.otherAdmins} other active administrator(s); an ADM recovery needs two (DQ-16).`);
      return;
    }
    if (command.kind === 'create') {
      assertDev(config.env, 'dev:staff create');
      const [result] = await bootstrapStaff(deps, parseSpec([command.spec], config.env));
      if (result!.status === 'exists') throw new Error(`${result!.email} exists already (roles: ${result!.roles.join(',') || 'none'})`);
      print([result!]);
      return;
    }
    if (!command.file) assertDev(config.env, 'staff:bootstrap without --file');
    const specs = parseSpec(command.file ? JSON.parse(readFileSync(command.file, 'utf8')) : DEV_STAFF, config.env);
    const missing = shortfall(specs);
    if (missing.length) console.warn(`Warning: below the pilot minimum (two ADM, one MOD, one CRV): ${missing.join('; ')}`);
    print(await bootstrapStaff(deps, specs));
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
