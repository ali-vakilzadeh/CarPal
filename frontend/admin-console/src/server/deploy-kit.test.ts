// The deploy kit (AC11.T1) against the code it configures: the admin.env template must pass env.ts as rendered, and
// every @NAME@ placeholder of the templates must be one render() in deploy/lib.sh fills.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy');
const read = (...p: string[]) => readFileSync(join(DEPLOY, ...p), 'utf8');

const KEY = JSON.stringify({
  'cp-web-admin': { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'secret', kid: 'k1', alg: 'ES256', use: 'sig' },
});
// What admin-setup.sh renders for DOMAIN=carpals.ir with the default admin-deploy.conf.example.
const VALUES: Record<string, string> = {
  DOMAIN: 'carpals.ir',
  ADMIN_CONSOLE_HOST: 'admin.carpals.ir',
  ADMIN_HOST: 'admin-api.carpals.ir',
  WEB_HOST: 'pwa.carpals.ir',
  API_HOST: 'api.carpals.ir',
  AUTH_HOST: 'id.carpals.ir',
  MEDIA_HOST: 'media.carpals.ir',
  ADMIN_ENV: 'prod',
  ADMIN_SERVICE_NAME: 'carpal-admin',
  ADMIN_SERVICE_GROUP: 'carpal-admin',
  BACKEND_ADMIN_API_URL: 'http://127.0.0.1:8081',
  BACKEND_AUTH_URL: 'http://127.0.0.1:8082',
  CLIENT_PRIVATE_JWKS: KEY,
};

const render = (text: string) => text.replace(/@([A-Z_]+)@/g, (_, name: string) => VALUES[name] ?? `@${name}@`);

/** KEY=value lines as systemd's EnvironmentFile and `set -a; .` read them (one pair of single quotes removed). */
function envLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return out;
}

describe('deploy kit (AC11)', () => {
  it('renders an admin.env that env.ts accepts for production', () => {
    const rendered = render(read('templates', 'admin.env.template'));
    expect(rendered).not.toMatch(/@[A-Z_]+@/);
    const vars = envLines(rendered);
    const env = parseEnv(vars);
    expect(env).toMatchObject({
      CARPAL_ADMIN_ENV: 'prod',
      CARPAL_ADMIN_ORIGIN: 'https://admin.carpals.ir',
      CARPAL_ADMIN_API_AUDIENCE: 'https://admin-api.carpals.ir',
      CARPAL_STRICT_AUTH: true,
      CARPAL_STORAGE_URL: 'https://media.carpals.ir',
      CARPAL_ADMIN_PUBLIC_WEB_URL: 'https://pwa.carpals.ir',
      CARPAL_ADMIN_SESSION_STORE: 'lite',
    });
    expect(env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS?.['cp-web-admin']?.kid).toBe('k1');
    // Every variable the template sets is one env.ts reads (a typo would be ignored silently).
    for (const name of Object.keys(vars)) expect(env, name).toHaveProperty(name);
    // Never the dev shims on a server.
    expect(vars).not.toHaveProperty('CARPAL_ADMIN_OAUTH_REDIRECT_URI');
  });

  it('uses only placeholders that render() fills', () => {
    const lib = read('lib.sh');
    const list = /for name in "\$@" ([^;]+); do/.exec(lib.replace(/\\\n\s*/g, ' '))?.[1];
    expect(list).toBeTruthy();
    const known = new Set([...list!.split(/\s+/).filter(Boolean), 'CLIENT_PRIVATE_JWKS', 'GATE_RULES']);
    for (const file of readdirSync(join(DEPLOY, 'templates'))) {
      for (const [, name] of read('templates', file).matchAll(/@([A-Z_]+)@/g)) expect(known, `${file}: @${name}@`).toContain(name);
    }
  });

  it('keeps the console on loopback behind nginx with X-Forwarded-For appended (D-110)', () => {
    expect(read('templates', 'carpal-admin.service')).toContain('--hostname 127.0.0.1 --port @ADMIN_PORT@');
    expect(read('templates', 'nginx-carpal-admin-proxy.conf')).toContain('X-Forwarded-For $proxy_add_x_forwarded_for');
  });

  it('sets nothing at the nginx http level but its own zones (the backend site shares that context)', () => {
    // Every enabled site lands in one http context; a directive the backend's nginx-carpal.conf also sets there
    // (limit_req_status) would fail `nginx -t` as a duplicate. Outside server blocks only comments and zones.
    let depth = 0;
    for (const line of read('templates', 'nginx-carpal-admin.conf').split('\n')) {
      const code = line.replace(/#.*/, '').trim();
      if (depth === 0 && code && !code.startsWith('server {')) expect(code, line).toMatch(/^limit_req_zone \S+ zone=carpal_admin\w*:/);
      depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    }
    expect(depth).toBe(0);
  });

  it('has LF line ends only', () => {
    const files = ['lib.sh', 'admin-setup.sh', 'admin-update.sh', 'admin-deploy.conf.example'].map((f) => [f, read(f)] as const);
    for (const f of readdirSync(join(DEPLOY, 'templates'))) files.push([f, read('templates', f)]);
    for (const [name, text] of files) expect(text.includes('\r'), name).toBe(false);
  });
});
