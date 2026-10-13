// Appointment work on the worker deployable: the W15 reminder rule (41 §6.3).
import { Module } from '@nestjs/common';
import { AppointmentReminderRule } from './application/appointment-rules.js';

export { AppointmentReminderRule };

@Module({ providers: [AppointmentReminderRule] })
export class AppointmentWorkerModule {}
