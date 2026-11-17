// SMS gateway (backend S26a.T3): the port, the shared helpers, the providers and the registry.
export {
  assertE164,
  isOptOut,
  OPT_OUT_KEYWORDS,
  smsSegments,
  SmsSendError,
  type SmsCategory,
  type SmsGateway,
  type SmsOtpOptions,
  type SmsSendOptions,
  type SmsSendResult,
  type SmsStatus,
} from './gateway.js';
export { MockSmsGateway, MOCK_BALANCE, type MockSmsOptions, type MockSmsRecord } from './providers/mock.js';
export { FileSmsGateway } from './providers/file.js';
export { createSmsGateway, type SmsRegistryConfig } from './registry.js';
