#!/usr/bin/env node
// One strict backend for the integration tests of the admin console and the PWA (R-11, backend S25b), without
// hand-set variables. Plain .mjs without dependencies, like setup-local-node.mjs.
//
//   pnpm int:env init [--force]        write backend/.env.test (the backend's side: strict auth, the public keys of
//                                      cp-web-consumer, cp-ssr and cp-web-admin, redirect URIs, WebAuthn origins,
//                                      rate-limit scale) and backend/.env.test-clients (the clients' side: their
//                                      private keys). Both are git-ignored; --force makes new keys.
//   pnpm int:env backend [--lite]      pnpm dev with backend/.env.test (strict; --lite: CARPAL_STRICT_AUTH=0)
//   pnpm int:env clients [--lite] [console] [pwa] [--keep]
//                                      in a second shell: pnpm test:int of the console (strict and lite) and of the
//                                      PWA (lite only, see below), then pnpm dev:staff prune of the test staff accounts
//                                      (--keep skips it). Exit code 1 if a suite failed.
//   pnpm int:env env [--powershell]    the clients' variables as shell lines, for the E2E commands of the console and
//                                      the PWA READMEs (e.g. eval "$(pnpm -s int:env env)")
//
// The PWA's two integration suites (src/server/bff/*.int.test.ts) build a lite BFF and call /oauth/token and the
// search directly without a client assertion or DPoP, so they run against `backend --lite` until the PWA refinement
// round makes them strict-aware (backend/BE-Integration-plan.json T1.04, PWA PB-08). The PWA's strict acceptance is its E2E run (pwa/README.md
// "Strict mode"), which takes the same keys from `env`.
//
// Variables set in backend/.env.test win over backend/.env (process.loadEnvFile never overwrites a set variable).
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(backendDir, '..');
const BACKEND_ENV = join(backendDir, '.env.test');
const CLIENT_ENV = join(backendDir, '.env.test-clients');
const API = 'http://127.0.0.1:8080';
const AUTH = 'http://127.0.0.1:8082';
const TARGETS = {
  console: join(repoDir, 'frontend', 'admin-console'),
  pwa: join(repoDir, 'pwa'),
};
const STAFF_DOMAIN = 'staff.carpals.test';
const STAFF_PREFIXES = 'e2e-,bff-int-'; // tools/db/staff.ts TEST_STAFF_PREFIXES

// Redirect URIs and WebAuthn origins of the dev servers and test runs: PWA :3000 and its Playwright :3100 (pwa/README),
// console :3200 and its Playwright :3300 (frontend/admin-console/README "Integration tests"); cp-mobile and
// cp-web-portal keep the dev defaults of libs/config (the variable replaces the whole map).
const REDIRECT_URIS = {
  'cp-mobile': ['https://carpals.ir/oauth/callback'],
  'cp-web-consumer': ['https://localhost:3000/bff/oauth/callback', 'https://localhost:3100/bff/oauth/callback'],
  'cp-web-portal': ['https://web.carpals.ir/bff/oauth/callback'],
  'cp-web-admin': ['https://localhost:3200/bff/oauth/callback', 'https://localhost:3300/bff/oauth/callback'],
};
const WEBAUTHN_ORIGINS = ['https://localhost:3000', 'http://localhost:3200', 'http://localhost:3300'];

/** The same key shape as deploy/gen-client-keys.mjs: ES256, RFC 7638 thumbprint as kid. */
function keyPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const kid = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
  return { ...jwk, kid, alg: 'ES256', use: 'sig' };
}
const publicHalf = ({ d: _private, ...key }) => key;
const quoted = (value) => `'${JSON.stringify(value)}'`;

function init(force) {
  if (!force && existsSync(BACKEND_ENV) && existsSync(CLIENT_ENV)) {
    console.log(`${BACKEND_ENV} and ${CLIENT_ENV} exist (pnpm int:env init --force makes new keys).`);
    return;
  }
  const pwaKeys = { 'cp-web-consumer': keyPair(), 'cp-ssr': keyPair() };
  const adminKeys = { 'cp-web-admin': keyPair() };
  const publicJwks = Object.fromEntries(
    Object.entries({ ...pwaKeys, ...adminKeys }).map(([client, key]) => [client, { keys: [publicHalf(key)] }]),
  );
  const header = (side) =>
    [
      `# Integration-test settings, ${side} (backend/tools/int-env.mjs, R-11). Git-ignored; never copy these keys to a`,
      '# server. Regenerate with: pnpm int:env init --force',
    ].join('\n');
  writeFileSync(
    BACKEND_ENV,
    [
      header('backend side'),
      'CARPAL_ENV=dev',
      'CARPAL_STRICT_AUTH=1',
      'CARPAL_RATE_LIMIT_SCALE=100',
      'CARPAL_WEBAUTHN_RP_ID=localhost',
      `CARPAL_WEBAUTHN_ORIGINS=${quoted(WEBAUTHN_ORIGINS)}`,
      `CARPAL_OAUTH_REDIRECT_URIS=${quoted(REDIRECT_URIS)}`,
      `CARPAL_OAUTH_CLIENT_JWKS=${quoted(publicJwks)}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    CLIENT_ENV,
    [
      header('client side: the console and the PWA'),
      'CARPAL_STRICT_AUTH=1',
      `CARPAL_ADMIN_CLIENT_PRIVATE_JWKS=${quoted(adminKeys)}`,
      `CARPAL_PWA_CLIENT_PRIVATE_JWKS=${quoted(pwaKeys)}`,
      `CARPAL_API_URL=${API}`,
      `CARPAL_AUTH_URL=${AUTH}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log(`Wrote ${BACKEND_ENV} and ${CLIENT_ENV}.`);
  console.log('Next: pnpm int:env backend   (then, in a second shell: pnpm int:env clients)');
}

function load(file) {
  if (!existsSync(file)) {
    console.error(`${file} is missing: run pnpm int:env init first.`);
    process.exit(2);
  }
  return parseEnv(readFileSync(file, 'utf8'));
}

/** Children run on this Node (the project-local Node 24) and the pnpm next to it, whatever the shell's PATH says. */
function childEnv(extra) {
  const path = [dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ''].join(delimiter);
  const env = { ...process.env, ...extra, PATH: path };
  if (process.platform === 'win32') delete env.Path;
  return env;
}

function run(cmd, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function backend(lite) {
  const env = load(BACKEND_ENV);
  if (lite) env.CARPAL_STRICT_AUTH = '0';
  console.log(`Starting the backend (pnpm dev) with ${BACKEND_ENV}: strict auth ${lite ? 'off (--lite)' : 'on'}.`);
  process.exitCode = await run('pnpm', ['dev'], backendDir, childEnv(env));
}

async function reachable() {
  for (const url of [`${API}/v1/health`, `${AUTH}/.well-known/openid-configuration`]) {
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return url;
  }
  return null;
}

async function clients(args) {
  const lite = args.includes('--lite');
  const keep = args.includes('--keep');
  const asked = args.filter((a) => !a.startsWith('--'));
  for (const a of asked) if (!(a in TARGETS)) throw new Error(`unknown client "${a}" (console, pwa)`);
  const targets = asked.length ? asked : lite ? ['console', 'pwa'] : ['console'];
  if (!lite && targets.includes('pwa'))
    console.warn('Note: the PWA integration suites are lite-only today (see the header of this file); expect strict failures.');
  const down = await reachable();
  if (down) {
    console.error(`The backend does not answer at ${down}: start it first with pnpm int:env backend${lite ? ' --lite' : ''}.`);
    process.exit(2);
  }
  const env = load(CLIENT_ENV);
  if (lite) env.CARPAL_STRICT_AUTH = '0';
  const results = [];
  for (const t of targets) {
    console.log(`\n=== ${t}: pnpm test:int (strict auth ${lite ? 'off' : 'on'}) ===`);
    results.push([t, await run('pnpm', ['test:int'], TARGETS[t], childEnv(env))]);
  }
  if (!keep) {
    console.log(`\n=== pnpm dev:staff prune --domain ${STAFF_DOMAIN} --prefix ${STAFF_PREFIXES} ===`);
    results.push([
      'prune',
      await run('pnpm', ['dev:staff', 'prune', '--domain', STAFF_DOMAIN, '--prefix', STAFF_PREFIXES], backendDir, childEnv({})),
    ]);
  }
  console.log('');
  for (const [t, code] of results) console.log(`${code === 0 ? 'passed' : 'FAILED'}  ${t}`);
  process.exitCode = results.some(([, code]) => code !== 0) ? 1 : 0;
}

function printEnv(powershell) {
  for (const [k, v] of Object.entries(load(CLIENT_ENV)))
    console.log(powershell ? `$env:${k} = '${v.replace(/'/g, "''")}'` : `export ${k}='${v.replace(/'/g, `'\\''`)}'`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'init':
    init(rest.includes('--force'));
    break;
  case 'backend':
    await backend(rest.includes('--lite'));
    break;
  case 'clients':
    await clients(rest);
    break;
  case 'env':
    printEnv(rest.includes('--powershell'));
    break;
  default:
    console.error('usage: pnpm int:env init [--force] | backend [--lite] | clients [--lite] [console] [pwa] [--keep] | env [--powershell]');
    process.exit(2);
}
