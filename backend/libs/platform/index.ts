// Platform operations module (40 §22: health.get, config.client, jobs.get,
// jobs.cancel). Imported by the api app.
import { Module } from '@nestjs/common';
import { ClientConfigHandler, HealthHandler, JobsCancelHandler, JobsGetHandler } from './platform-ops.js';

export { ClientConfigHandler, HealthHandler, JobsCancelHandler, JobsGetHandler, TaxonomyVersion } from './platform-ops.js';

@Module({ providers: [HealthHandler, ClientConfigHandler, JobsGetHandler, JobsCancelHandler] })
export class PlatformOpsModule {}
