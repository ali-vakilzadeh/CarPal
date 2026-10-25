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
    });
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
  });
});
