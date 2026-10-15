import { Module } from '@nestjs/common';
import { JobsExpiryRule } from './jobs-expiry.rule.js';
import { MonthlyPartitionsRule } from './monthly-partitions.rule.js';
import { SchedulerService } from './scheduler.service.js';

/** W15 scheduler host with the platform's own rules; domain modules add ScheduledRule providers. */
@Module({ providers: [SchedulerService, MonthlyPartitionsRule, JobsExpiryRule], exports: [SchedulerService] })
export class SchedulerModule {}
