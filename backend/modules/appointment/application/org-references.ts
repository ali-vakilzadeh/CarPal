// Appointment's references to organizations for an organization merge (backend S22, BR-08): appointments (as the
// provider or the fleet requester), participants, opening hours and time off move to the surviving organization.
import { moveRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function appointmentOrgReferences(): OrgReference[] {
  return [
    moveRef('appointment.appointments', {
      table: 'appointment.appointments',
      columns: ['provider_organization_id', 'requester_organization_id'],
    }),
    moveRef('appointment.participants', { table: 'appointment.appointment_participants', columns: ['organization_id'] }),
    moveRef('appointment.availability_rules', { table: 'appointment.provider_availability_rules', columns: ['provider_organization_id'] }),
    moveRef('appointment.time_off', { table: 'appointment.provider_time_off', columns: ['provider_organization_id'] }),
  ];
}
