#!/usr/bin/env node
// R-04 (admin console dev-plan.json; backend S25b): after a change to Docs/40 or to shared/, bring both web clients to
// the backend contract and run their whole checks, in the order the console needs (it reads shared/api-contracts,
// which the PWA generates, and shared/i18n common/format, which only its own i18n:check covers, DI-11):
//
//   pnpm check:clients            backend contract:check, then pwa contract:generate, admin-console contract:generate,
//                                 pnpm check in pwa/, pnpm check in frontend/admin-console/
//   pnpm check:clients --no-generate   checks only (CI style: fails if a generated file is stale)
//
// Plain .mjs without dependencies. Children run on this Node (the project-local Node 24) whatever the shell's PATH says.
import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(backendDir, '..');
const pwa = join(repoDir, 'pwa');
const console_ = join(repoDir, 'frontend', 'admin-console');
const generate = !process.argv.includes('--no-generate');

const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ''].join(delimiter) };
if (process.platform === 'win32') delete env.Path;

const steps = [
  ['backend', backendDir, ['contract:check']],
  ...(generate
    ? [
        ['pwa', pwa, ['contract:generate']],
        ['admin-console', console_, ['contract:generate']],
      ]
    : []),
  ['pwa', pwa, ['check']],
  ['admin-console', console_, ['check']],
];

for (const [name, cwd, args] of steps) {
  console.log(`\n=== ${name}: pnpm ${args.join(' ')} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (c, signal) => resolve(signal ? 1 : (c ?? 1)));
  });
  if (code !== 0) {
    console.error(`\n${name}: pnpm ${args.join(' ')} failed (exit ${code}).`);
    process.exit(1);
  }
}
console.log('\nBoth clients match the backend contract and pass their checks.');
