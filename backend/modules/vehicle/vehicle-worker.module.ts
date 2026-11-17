// Vehicle work on the worker deployable: the hourly W15 rule (41 §6.3)
// for maintenance reminders and document expiry.
import { Module } from '@nestjs/common';
import { VehicleOdometerPromptRule } from './application/odometer-prompt-rule.js';
import { VehicleReminderRule } from './application/reminder-rule.js';
import { VehicleTransferExpiryRule } from './application/transfer-ops.js';

@Module({ providers: [VehicleReminderRule, VehicleOdometerPromptRule, VehicleTransferExpiryRule] })
export class VehicleWorkerModule {}
