// DI tokens for platform values that are not classes. Classes (TxRunner,
// FlagService, JobService, …) are their own tokens.

/** CarpalConfig (libs/config). */
export const CARPAL_CONFIG = Symbol.for('carpal.config');
/** pino Logger of the process, bound with the host name. */
export const LOGGER = Symbol.for('carpal.logger');
/** Infra adapters (libs/infra). */
export const INFRA = Symbol.for('carpal.infra');
/** Which deployable this Nest context is: api | admin-api | auth | worker. */
export const HOST = Symbol.for('carpal.host');

export type RuntimeHost = 'api' | 'admin-api' | 'auth' | 'worker';
