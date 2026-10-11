import { Module } from '@nestjs/common';
import { MonthlyPartitionsRule } from './monthly-partitions.rule.js';
import { SchedulerService } from './scheduler.service.js';

/** W15 scheduler host with the platform's own rules; domain modules add ScheduledRule providers. */
@Module({ providers: [SchedulerService, MonthlyPartitionsRule], exports: [SchedulerService] })
export class SchedulerModule {}
