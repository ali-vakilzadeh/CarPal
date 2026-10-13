// Appointment operations (40 §16) and public.availability (40 §14.3) on the
// api host. Needs AppointmentModule, OrganizationModule, IdentityModule,
// VehicleModule, MediaModule, TrustModule, DiscoveryModule, TaxonomyModule,
// BillingModule and NotificationMessagingModule (global) in the same application.
import { Module } from '@nestjs/common';
import {
  AvailabilityRuleCreateHandler,
  AvailabilityRuleDeleteHandler,
  AvailabilityRulesListHandler,
  AvailabilityRuleUpdateHandler,
  AvailabilityTimeOffCancelHandler,
  AvailabilityTimeOffCreateHandler,
  AvailabilityTimeOffListHandler,
  PublicAvailabilityHandler,
} from './application/availability-ops.js';
import { Capacity } from './application/capacity.js';
import { AppointmentViews } from './application/common.js';
import { PreVisitReports } from './application/pre-visit.js';
import {
  PreVisitProviderGetHandler,
  ProviderAppointmentsGetHandler,
  ProviderAppointmentsListHandler,
  ProviderAppointmentsTransitionHandler,
  ProviderAppointmentsUpdateHandler,
  ProviderCalendarHandler,
  ProviderNoteCreateHandler,
  ProviderNotesListHandler,
  ProviderParticipantAddHandler,
  ProviderParticipantRemoveHandler,
  ProviderParticipantsListHandler,
} from './application/provider-ops.js';
import {
  AppointmentsCheckInHandler,
  AppointmentsCheckInLinkHandler,
  AppointmentsCreateHandler,
  AppointmentsDelayHandler,
  AppointmentsGetHandler,
  AppointmentsHistoryHandler,
  AppointmentsListHandler,
  AppointmentsNoteCreateHandler,
  AppointmentsNotesListHandler,
  AppointmentsTransitionHandler,
  AppointmentsUpdateHandler,
  Confirmation,
  NoteViews,
  PreVisitRequesterGetHandler,
} from './application/requester-ops.js';

@Module({
  providers: [
    AppointmentViews,
    NoteViews,
    PreVisitReports,
    Capacity,
    Confirmation,
    // requester (§16.2)
    AppointmentsCreateHandler,
    AppointmentsListHandler,
    AppointmentsGetHandler,
    AppointmentsUpdateHandler,
    AppointmentsTransitionHandler,
    AppointmentsDelayHandler,
    AppointmentsCheckInHandler,
    AppointmentsCheckInLinkHandler,
    AppointmentsHistoryHandler,
    AppointmentsNotesListHandler,
    AppointmentsNoteCreateHandler,
    PreVisitRequesterGetHandler,
    // provider (§16.3)
    ProviderAppointmentsListHandler,
    ProviderAppointmentsGetHandler,
    ProviderAppointmentsUpdateHandler,
    ProviderAppointmentsTransitionHandler,
    ProviderParticipantsListHandler,
    ProviderParticipantAddHandler,
    ProviderParticipantRemoveHandler,
    ProviderNotesListHandler,
    ProviderNoteCreateHandler,
    PreVisitProviderGetHandler,
    ProviderCalendarHandler,
    // calendar settings (§16.3) and public slots (§14.3)
    AvailabilityRulesListHandler,
    AvailabilityRuleCreateHandler,
    AvailabilityRuleUpdateHandler,
    AvailabilityRuleDeleteHandler,
    AvailabilityTimeOffListHandler,
    AvailabilityTimeOffCreateHandler,
    AvailabilityTimeOffCancelHandler,
    PublicAvailabilityHandler,
  ],
})
export class AppointmentApiModule {}
