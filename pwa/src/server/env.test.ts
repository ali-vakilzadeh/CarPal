import { describe, expect, it } from 'vitest';
import { parseServerEnv } from './env';

describe('server env', () => {
  it('applies the dev defaults', () => {
    expect(parseServerEnv({})).toEqual({
      CARPAL_ENV: 'dev',
      CARPAL_PWA_ORIGIN: 'http://localhost:3000',
      CARPAL_API_URL: 'http://127.0.0.1:8080',
      CARPAL_AUTH_URL: 'http://127.0.0.1:8082',
      CARPAL_STORAGE_URL: 'http://127.0.0.1:8083',
      CARPAL_API_AUDIENCE: 'https://api.carpal.app',
      CARPAL_STRICT_AUTH: false,
      CARPAL_PWA_SESSION_STORE: 'lite',
      CARPAL_PWA_DEMO: false,
      CARPAL_PWA_DEFAULT_TIME_ZONE: 'Asia/Tehran',
      CARPAL_PWA_TERMS_VERSION: '2026-10',
      CARPAL_PWA_PRIVACY_VERSION: '2026-10',
      CARPAL_PWA_PORTAL_SIGNUP_URL: 'https://portal.carpal.app/signup',
      CARPAL_PWA_PORTAL_URL: 'https://portal.carpal.app',
    });
  });

  it('validates the P12 web push key: empty = no web push, otherwise a base64url P-256 key', () => {
    expect(parseServerEnv({ CARPAL_PWA_VAPID_PUBLIC_KEY: '' }).CARPAL_PWA_VAPID_PUBLIC_KEY).toBeUndefined();
    const key = `B${'A'.repeat(86)}`;
    expect(parseServerEnv({ CARPAL_PWA_VAPID_PUBLIC_KEY: key }).CARPAL_PWA_VAPID_PUBLIC_KEY).toBe(key);
    expect(() => parseServerEnv({ CARPAL_PWA_VAPID_PUBLIC_KEY: 'not a key' })).toThrow(/CARPAL_PWA_VAPID_PUBLIC_KEY/);
  });

  it('validates the P4 values: default time zone (OQ-13), policy versions, dev-only redirect URI', () => {
    expect(parseServerEnv({ CARPAL_PWA_DEFAULT_TIME_ZONE: 'Europe/Berlin' }).CARPAL_PWA_DEFAULT_TIME_ZONE).toBe('Europe/Berlin');
    expect(() => parseServerEnv({ CARPAL_PWA_DEFAULT_TIME_ZONE: 'Mars/Olympus' })).toThrow(/CARPAL_PWA_DEFAULT_TIME_ZONE/);
    expect(() => parseServerEnv({ CARPAL_PWA_TERMS_VERSION: 'x'.repeat(21) })).toThrow(/CARPAL_PWA_TERMS_VERSION/);
    const uri = 'https://localhost:3100/bff/oauth/callback';
    expect(parseServerEnv({ CARPAL_PWA_OAUTH_REDIRECT_URI: uri }).CARPAL_PWA_OAUTH_REDIRECT_URI).toBe(uri);
    expect(() =>
      parseServerEnv({
        CARPAL_ENV: 'prod',
        CARPAL_PWA_ORIGIN: 'https://carpal.app',
        CARPAL_STORAGE_URL: 'https://media.carpal.app',
        CARPAL_PWA_SESSION_STORE: 'redis',
        CARPAL_PWA_REDIS_URL: 'redis://r:6379',
        CARPAL_PWA_OAUTH_REDIRECT_URI: uri,
      }),
    ).toThrow(/CARPAL_PWA_OAUTH_REDIRECT_URI/);
  });

  it('reads the demo switch and the maintenance value (P3)', () => {
    expect(parseServerEnv({ CARPAL_PWA_DEMO: '1' }).CARPAL_PWA_DEMO).toBe(true);
    expect(parseServerEnv({ CARPAL_PWA_MAINTENANCE: '2026-10-25T12:00:00Z' }).CARPAL_PWA_MAINTENANCE).toBe('2026-10-25T12:00:00Z');
    expect(() => parseServerEnv({ CARPAL_PWA_DEMO: 'true' })).toThrow(/CARPAL_PWA_DEMO/);
  });

  it('treats empty values as unset', () => {
    expect(parseServerEnv({ CARPAL_PWA_MAP_STYLE_URL: '', CARPAL_API_URL: '' }).CARPAL_API_URL).toBe('http://127.0.0.1:8080');
  });

  it('reads the strict-mode switch as a boolean', () => {
    expect(parseServerEnv({ CARPAL_STRICT_AUTH: '1' }).CARPAL_STRICT_AUTH).toBe(true);
    expect(() => parseServerEnv({ CARPAL_STRICT_AUTH: 'yes' })).toThrow(/CARPAL_STRICT_AUTH/);
  });

  it('lists every invalid variable', () => {
    expect(() => parseServerEnv({ CARPAL_API_URL: 'not a url', CARPAL_PWA_SESSION_STORE: 'redis' })).toThrow(
      /CARPAL_API_URL[\s\S]*CARPAL_PWA_REDIS_URL: required when CARPAL_PWA_SESSION_STORE=redis/,
    );
  });

  it('enforces https and redis in prod', () => {
    expect(() => parseServerEnv({ CARPAL_ENV: 'prod' })).toThrow(/CARPAL_PWA_ORIGIN: must be https in prod[\s\S]*redis session store/);
    expect(
      parseServerEnv({
        CARPAL_ENV: 'prod',
        CARPAL_PWA_ORIGIN: 'https://carpal.app',
        CARPAL_STORAGE_URL: 'https://media.carpal-usercontent.app',
        CARPAL_PWA_SESSION_STORE: 'redis',
        CARPAL_PWA_REDIS_URL: 'redis://cache:6379',
      }).CARPAL_ENV,
    ).toBe('prod');
    expect(() =>
      parseServerEnv({
        CARPAL_ENV: 'prod',
        CARPAL_PWA_ORIGIN: 'https://carpal.app',
        CARPAL_STORAGE_URL: 'https://media.carpal-usercontent.app',
        CARPAL_PWA_SESSION_STORE: 'redis',
        CARPAL_PWA_REDIS_URL: 'redis://cache:6379',
        CARPAL_PWA_DEMO: '1',
      }),
    ).toThrow(/CARPAL_PWA_DEMO: must be 0 in prod/);
  });
});
