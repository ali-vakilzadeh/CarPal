import { describe, expect, it } from 'vitest';
import { DEV_MASTER_SECRET, loadConfig } from './index.js';

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
    expect(loadConfig({ CARPAL_ENV: 'prod', CARPAL_MASTER_SECRET: 'x'.repeat(40), CARPAL_STRICT_AUTH: '1' }).strictAuth).toBe(true);
  });

  it('lists every invalid variable', () => {
    expect(() => loadConfig({ CARPAL_API_PORT: 'abc', CARPAL_CLIENT_MIN_VERSIONS: '{"cp-mobile":"1.x"}' })).toThrow(
      /CARPAL_API_PORT[\s\S]*CARPAL_CLIENT_MIN_VERSIONS/,
    );
  });
});
