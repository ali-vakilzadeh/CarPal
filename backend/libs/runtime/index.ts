// Process wiring of the platform libraries for NestJS (S2.T12): the global
// PlatformModule, the HTTP host that mounts the contract pipeline, and tokens.
export {
  PlatformModule,
  AttestationVerifierPort,
  InjectConfig,
  InjectInfra,
  InjectLogger,
  type PlatformOptions,
} from './platform.module.js';
export { createHttpHost, discoverHandlers, type HttpHost, type HttpHostName } from './http-host.js';
export { CARPAL_CONFIG, HOST, INFRA, LOGGER, type RuntimeHost } from './tokens.js';
