// pnpm seed:consent-texts --file <json> [--region ir-pilot] [--allow-placeholders]   (backend S26a.T5; consent-texts.ts)
// Connects as carpal_worker like staff-cli (backend/.env in dev; on a server deploy/seed-consent-texts.sh loads
// /carpal/config/backend.env first).
import { readFileSync } from 'node:fs';
import { loadConfig } from '#libs/config/index.js';
import { Database } from '#libs/db/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { parseConsentTexts, parseSeedArgs, seedConsentTexts } from './consent-texts.js';

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2));
  const config = loadConfig();
  const items = parseConsentTexts(JSON.parse(readFileSync(args.file, 'utf8')), {
    env: config.env,
    allowPlaceholders: args.allowPlaceholders,
  });
  const database = new Database(config, 'carpal_worker', { applicationName: 'carpal-consent-seed', max: 2 });
  try {
    const region = args.region ?? config.region;
    const results = await seedConsentTexts(new TxRunner(database), region, items);
    for (const r of results)
      console.log(
        `${r.status === 'created' ? 'created' : 'exists '}  ${r.consent_type}  ${r.policy_version}${r.existing_status ? `  (${r.existing_status}, left as it is)` : '  (draft)'}`,
      );
    const created = results.filter((r) => r.status === 'created').length;
    console.log(`\n${created} draft(s) created in region ${region}. Publish them in the admin console: Policies (A-POL-01),`);
    console.log('one per consent type, with an effective date; a second administrator approves each (four eyes).');
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
