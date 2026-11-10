import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const KEY = JSON.stringify({ 'cp-web-admin': { kty: 'EC', crv: 'P-256', kid: 'k1', d: 'secret', x: 'x', y: 'y' } });
const PROD = {
  CARPAL_ADMIN_ENV: 'prod',
  CARPAL_ADMIN_ORIGIN: 'https://admin.carpals.ir',
  CARPAL_STRICT_AUTH: '1',
  CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: KEY,
  CARPAL_STORAGE_URL: 'https://media.carpal-usercontent.app',
  CARPAL_ADMIN_PUBLIC_WEB_URL: 'https://pwa.carpals.ir',
};

describe('server env (AC1.T5, AC3.T1)', () => {
  it('defaults to a dev console on :3200 in Persian against backend lite', () => {
    expect(parseEnv({})).toEqual({
      CARPAL_ADMIN_ENV: 'dev',
      CARPAL_ADMIN_ORIGIN: 'http://localhost:3200',
      CARPAL_ADMIN_DEFAULT_LOCALE: 'fa',
      CARPAL_ADMIN_DEFAULT_TIME_ZONE: 'Asia/Tehran',
      CARPAL_ADMIN_API_URL: 'http://127.0.0.1:8081',
      CARPAL_AUTH_URL: 'http://127.0.0.1:8082',
      CARPAL_STORAGE_URL: 'http://127.0.0.1:8083',
      CARPAL_ADMIN_PUBLIC_WEB_URL: 'http://localhost:3000',
      CARPAL_ADMIN_API_AUDIENCE: 'https://admin-api.carpals.ir',
      CARPAL_STRICT_AUTH: false,
      CARPAL_ADMIN_SESSION_STORE: 'lite',
    });
  });

  it('refuses unknown environments, bad zones and http outside dev', () => {
    expect(() => parseEnv({ CARPAL_ADMIN_ENV: 'live' })).toThrow(/CARPAL_ADMIN_ENV/);
    expect(() => parseEnv({ CARPAL_ADMIN_DEFAULT_TIME_ZONE: 'Mars/Base' })).toThrow(/IANA/);
    expect(() => parseEnv({ ...PROD, CARPAL_ADMIN_ORIGIN: 'http://admin.example' })).toThrow(/https/);
    expect(() => parseEnv({ ...PROD, CARPAL_STORAGE_URL: 'http://media.example' })).toThrow(/CARPAL_STORAGE_URL/);
    expect(() => parseEnv({ ...PROD, CARPAL_ADMIN_PUBLIC_WEB_URL: 'http://pwa.example' })).toThrow(/CARPAL_ADMIN_PUBLIC_WEB_URL/);
    expect(() => parseEnv({ ...PROD, CARPAL_ADMIN_MAP_STYLE_URL: 'http://tiles.example/style.json' })).toThrow(
      /CARPAL_ADMIN_MAP_STYLE_URL/,
    );
    expect(parseEnv({ ...PROD, CARPAL_ADMIN_MAP_STYLE_URL: 'https://tiles.example/style.json' }).CARPAL_ADMIN_MAP_STYLE_URL).toBe(
      'https://tiles.example/style.json',
    );
    expect(parseEnv(PROD).CARPAL_ADMIN_ENV).toBe('prod');
  });

  it('needs the cp-web-admin private key and strict mode outside dev, and in strict mode', () => {
    expect(() => parseEnv({ ...PROD, CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: '' })).toThrow(/CARPAL_ADMIN_CLIENT_PRIVATE_JWKS/);
    expect(() => parseEnv({ ...PROD, CARPAL_STRICT_AUTH: '0' })).toThrow(/CARPAL_STRICT_AUTH/);
    expect(() => parseEnv({ CARPAL_STRICT_AUTH: '1' })).toThrow(/private key of cp-web-admin/);
    expect(
      parseEnv({ CARPAL_STRICT_AUTH: '1', CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: KEY }).CARPAL_ADMIN_CLIENT_PRIVATE_JWKS?.['cp-web-admin']?.kid,
    ).toBe('k1');
  });

  it('keeps the redirect-URI override in dev and needs a Redis URL for the redis store', () => {
    expect(() => parseEnv({ ...PROD, CARPAL_ADMIN_OAUTH_REDIRECT_URI: 'https://localhost:3200/bff/oauth/callback' })).toThrow(
      /dev and E2E only/,
    );
    expect(parseEnv({ CARPAL_ADMIN_OAUTH_REDIRECT_URI: 'https://localhost:3200/bff/oauth/callback' }).CARPAL_ADMIN_OAUTH_REDIRECT_URI).toBe(
      'https://localhost:3200/bff/oauth/callback',
    );
    expect(() => parseEnv({ CARPAL_ADMIN_SESSION_STORE: 'redis' })).toThrow(/CARPAL_ADMIN_REDIS_URL/);
  });
});
