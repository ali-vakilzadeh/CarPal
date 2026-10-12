// Vehicle work on the worker deployable: the hourly W15 rule (41 §6.3)
// for maintenance reminders and document expiry.
import { Module } from '@nestjs/common';
import { VehicleReminderRule } from './application/reminder-rule.js';

@Module({ providers: [VehicleReminderRule] })
export class VehicleWorkerModule {}
