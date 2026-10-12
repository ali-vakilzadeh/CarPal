// Appointment operations on the api host. S6 serves only the public.availability
// placeholder (40 §14.3, empty slots); S7 builds the appointment module
// (requests, calendar, capacity, pre-visit report) around it.
import { Module } from '@nestjs/common';
import { PublicAvailabilityHandler } from './application/availability-ops.js';

@Module({ providers: [PublicAvailabilityHandler] })
export class AppointmentApiModule {}
