import { describe, expect, it } from 'vitest';
import { DEV_MASTER_SECRET, loadConfig } from './index.js';

/** A valid environment outside dev: a real master secret, random role passwords, the https media origin. */
function stagingEnv(env = 'staging'): Record<string, string> {
  const pw = (k: string) => [`CARPAL_DB_PASSWORD_${k}`, `random-${k.toLowerCase()}-password`];
  return {
    CARPAL_ENV: env,
    CARPAL_MASTER_SECRET: 'x'.repeat(40),
    CARPAL_MEDIA_BASE_URL: 'https://media.carpals.ir',
    ...Object.fromEntries(['API', 'ADMIN_API', 'AUTH', 'WORKER', 'ANALYTICS_WRITER', 'ANALYTICS_READER', 'AI'].map(pw)),
  };
}

describe('loadConfig', () => {
  it('has lite-mode defaults', () => {
    const c = loadConfig({ CARPAL_ENV: 'dev', CARPAL_INFRA: undefined, CARPAL_MASTER_SECRET: undefined });
    expect(c.infra).toBe('lite');
    expect(c.http.ports.api).toBe(8080);
    expect(c.secrets.isDevMaster).toBe(true);
    expect(c.pipeline.validateResponses).toBe(true);
    expect(Object.isFrozen(c.http)).toBe(true);
  });

  it('refuses the development secret outside dev and lax auth in prod', () => {
    expect(() => loadConfig({ CARPAL_ENV: 'staging', CARPAL_MASTER_SECRET: DEV_MASTER_SECRET })).toThrow(/CARPAL_MASTER_SECRET/);
    expect(() => loadConfig({ CARPAL_ENV: 'prod', CARPAL_MASTER_SECRET: 'x'.repeat(40), CARPAL_STRICT_AUTH: '0' })).toThrow(
      /CARPAL_STRICT_AUTH/,
    );
    const keys = JSON.stringify({ 'cp-web-consumer': { keys: [{ kty: 'EC' }] }, 'cp-ssr': { keys: [{ kty: 'EC' }] } });
    expect(loadConfig({ ...stagingEnv('prod'), CARPAL_STRICT_AUTH: '1', CARPAL_OAUTH_CLIENT_JWKS: keys }).strictAuth).toBe(true);
  });

  it('lists every invalid variable', () => {
    expect(() => loadConfig({ CARPAL_API_PORT: 'abc', CARPAL_CLIENT_MIN_VERSIONS: '{"cp-mobile":"1.x"}' })).toThrow(
      /CARPAL_API_PORT[\s\S]*CARPAL_CLIENT_MIN_VERSIONS/,
    );
  });

  it('strict mode needs the public keys of the BFF clients and refuses private keys (GD-06 amendment 2026-11-04)', () => {
    expect(() => loadConfig({ CARPAL_STRICT_AUTH: '1', CARPAL_OAUTH_CLIENT_JWKS: undefined })).toThrow(
      /CARPAL_OAUTH_CLIENT_JWKS: needs the public key of cp-web-consumer/,
    );
    expect(() =>
      loadConfig({ CARPAL_STRICT_AUTH: '1', CARPAL_OAUTH_CLIENT_JWKS: JSON.stringify({ 'cp-web-consumer': { keys: [{ kty: 'EC' }] } }) }),
    ).toThrow(/needs the public key of cp-ssr/);
    expect(() => loadConfig({ CARPAL_OAUTH_CLIENT_JWKS: JSON.stringify({ 'cp-ssr': { keys: [{ kty: 'EC', d: 'secret' }] } }) })).toThrow(
      /private key material/,
    );
  });

  it('refuses the development role passwords and an http or missing media origin outside dev (S26c.T1, NI-18)', () => {
    expect(() => loadConfig({ ...stagingEnv(), CARPAL_DB_PASSWORD_API: undefined })).toThrow(
      /CARPAL_DB_PASSWORD_API: is the development password of carpal_api/,
    );
    expect(() => loadConfig({ ...stagingEnv(), CARPAL_DB_PASSWORD_AI: 'carpal_ai_dev' })).toThrow(/CARPAL_DB_PASSWORD_AI/);
    expect(() => loadConfig({ ...stagingEnv(), CARPAL_MEDIA_BASE_URL: undefined })).toThrow(
      /CARPAL_MEDIA_BASE_URL: must be set outside dev/,
    );
    expect(() => loadConfig({ ...stagingEnv(), CARPAL_MEDIA_BASE_URL: 'http://127.0.0.1:8083' })).toThrow(
      /CARPAL_MEDIA_BASE_URL: must be an https/,
    );
    expect(loadConfig(stagingEnv()).http.mediaBaseUrl).toBe('https://media.carpals.ir');
    // dev keeps its defaults (the lite listener and the <role>_dev passwords).
    expect(
      loadConfig({ CARPAL_ENV: 'dev', CARPAL_MEDIA_BASE_URL: undefined, CARPAL_DB_PASSWORD_API: undefined }).db.passwords.carpal_api,
    ).toBe('carpal_api_dev');
  });

  it('allows the local PWA origins on the storage listener in dev only (PWA DI-08)', () => {
    expect(loadConfig({ CARPAL_ENV: 'dev', CARPAL_MEDIA_CORS_ORIGINS: undefined }).media.corsOrigins).toContain('http://localhost:3000');
    const staging = loadConfig({ ...stagingEnv(), CARPAL_MEDIA_CORS_ORIGINS: undefined });
    expect(staging.media.corsOrigins).toEqual([]);
    expect(loadConfig({ CARPAL_MEDIA_CORS_ORIGINS: '["https://pwa.carpals.ir"]' }).media.corsOrigins).toEqual(['https://pwa.carpals.ir']);
    expect(() => loadConfig({ CARPAL_MEDIA_CORS_ORIGINS: '["https://pwa.carpals.ir/path"]' })).toThrow(/CARPAL_MEDIA_CORS_ORIGINS/);
  });
});
