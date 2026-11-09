import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('server env (AC1.T5)', () => {
  it('defaults to a dev console on :3200 in Persian', () => {
    expect(parseEnv({})).toEqual({
      CARPAL_ADMIN_ENV: 'dev',
      CARPAL_ADMIN_ORIGIN: 'http://localhost:3200',
      CARPAL_ADMIN_DEFAULT_LOCALE: 'fa',
      CARPAL_ADMIN_DEFAULT_TIME_ZONE: 'Asia/Tehran',
    });
  });

  it('refuses unknown environments, bad zones and http outside dev', () => {
    expect(() => parseEnv({ CARPAL_ADMIN_ENV: 'live' })).toThrow(/CARPAL_ADMIN_ENV/);
    expect(() => parseEnv({ CARPAL_ADMIN_DEFAULT_TIME_ZONE: 'Mars/Base' })).toThrow(/IANA/);
    expect(() => parseEnv({ CARPAL_ADMIN_ENV: 'prod', CARPAL_ADMIN_ORIGIN: 'http://admin.example' })).toThrow(/https/);
    expect(parseEnv({ CARPAL_ADMIN_ENV: 'prod', CARPAL_ADMIN_ORIGIN: 'https://admin.carpals.ir' }).CARPAL_ADMIN_ENV).toBe('prod');
  });
});
