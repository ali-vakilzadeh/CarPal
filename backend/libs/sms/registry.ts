// Provider registry (backend S26a.T3): CARPAL_SMS_PROVIDER chooses the SmsGateway. Adding the owner's provider is a
// new providers/<vendor>.ts (see vendor-adapter.example.ts) and one case here.
import type { SmsGateway } from './gateway.js';
import { FileSmsGateway } from './providers/file.js';
import { MockSmsGateway } from './providers/mock.js';

export interface SmsRegistryConfig {
  env: 'dev' | 'staging' | 'prod';
  sms: {
    provider: 'mock' | 'file';
    mock: { deliveryMs: number; failPermanent: readonly string[]; failTemporary: readonly string[] };
  };
}

export function createSmsGateway(config: SmsRegistryConfig, o: { dataDir: string | null; countryCodes?: readonly string[] }): SmsGateway {
  switch (config.sms.provider) {
    case 'file':
      return new FileSmsGateway(o.dataDir, o.countryCodes ?? []);
    case 'mock':
      return new MockSmsGateway({
        dataDir: o.dataDir,
        restrictFile: config.env !== 'dev',
        deliveryMs: config.sms.mock.deliveryMs,
        failPermanent: config.sms.mock.failPermanent,
        failTemporary: config.sms.mock.failTemporary,
        countryCodes: o.countryCodes ?? [],
      });
  }
}
