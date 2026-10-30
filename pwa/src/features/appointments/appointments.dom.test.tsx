// P10.T4-T6 (DOM): W-APP-01 — accepting the shop's proposed time, cancelling with a reason, "Needs your action" in the
// list; /l/ci — the check-in link sends the fragment's token only on "I've arrived" and explains the time window; the
// notification's inline Accept time.
import type { Appointment, Notification } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { guest, renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { forgetFragmentTokens } from '@/features/auth';
import { NotificationItem } from '@/features/notifications';
import { ApiProblem } from '@/lib/api/problem';
import { AppointmentDetail } from './appointment-detail';
import { AppointmentsScreen } from './appointments-screen';
import { CheckInLinkPage } from './check-in-link';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const ID = '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function appt(o: Partial<Appointment> = {}): Appointment {
  return {
    id: ID,
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    version: 3,
    requester_type: 'user',
    requester_display: 'Sara M.',
    requester_organization_id: null,
    provider: {
      id: 'org-1',
      slug: null,
      name: 'Reza Auto Suspension',
      organization_type: 'provider',
      roles: ['provider'],
      verified: true,
      overall_rating: '4.8',
      review_count: 12,
      top_badges: [],
      price_tier: null,
      measured_response_time_minutes: null,
      logo_url: null,
      portfolio_thumbnail_url: null,
    },
    provider_location: null,
    provider_location_exact: null,
    vehicle: {
      id: 'v1',
      brand: { text: 'BMW', locale: 'en' },
      model: { text: '320i', locale: 'en' },
      series: null,
      year: 2012,
      nickname: 'Silver',
    },
    source: 'ai_match',
    match_result_id: null,
    related_issue_id: null,
    triage_session_id: 't1',
    triage_status: 'provided',
    safety_flag: false,
    fleet_approval_id: null,
    appointment_type: 'diagnosis',
    service_mode: 'in_shop',
    service_system: { text: 'Suspension', locale: 'en' },
    service_task: null,
    symptom: null,
    description: 'Clunk from the front right over bumps',
    content_locale: 'en',
    urgency_level: 'medium',
    customer_expectations: null,
    preferred_contact_channel: 'in_app',
    time_windows: [],
    proposed_start_at: '2026-11-05T10:30:00Z',
    proposed_end_at: '2026-11-05T11:30:00Z',
    confirmed_start_at: null,
    confirmed_end_at: null,
    estimated_duration_minutes: null,
    estimated_completion_from: null,
    estimated_completion_to: null,
    parts_availability_note: null,
    checked_in_at: null,
    customer_delay_minutes: null,
    cost_estimate: null,
    consent_to_share_history: true,
    status: 'alternative_proposed',
    cancelled_by: null,
    cancellation_reason: null,
    completed_at: null,
    service_record_id: null,
    can_review: false,
    allowed_transitions: ['confirmed', 'requested', 'cancelled'],
    requester_contact: null,
    ...o,
  };
}

const reads = (a: Appointment): Handlers => ({
  'appointments.get': () => a,
  'appointments.history': () => ({ items: [], next_cursor: null }),
  'appointments.notes_list': () => ({ items: [], next_cursor: null }),
});

beforeEach(() => {
  navigation.reset(`/en/appointments/${ID}`);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(String(input) === '/bff/csrf' ? json({ csrf_token: 'c' }) : json({}, 404))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('appointment detail', () => {
  it('accepts the time the shop proposed', async () => {
    const {
      api: { calls },
    } = renderApp(<AppointmentDetail appointmentId={ID} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...reads(appt()),
        'appointments.transition': () =>
          appt({ status: 'confirmed', confirmed_start_at: '2026-11-05T10:30:00Z', allowed_transitions: ['cancelled', 'checked_in'] }),
      },
    });
    expect(await screen.findByText(/Reza Auto Suspension proposed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Your visit is confirmed')).toBeTruthy();
    expect(calls.find((c) => c.opId === 'appointments.transition')!.args).toMatchObject({
      path: { appointment_id: ID },
      body: { to: 'confirmed' },
    });
  });

  it('explains a time that is no longer free', async () => {
    renderApp(<AppointmentDetail appointmentId={ID} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...reads(appt()),
        'appointments.transition': () => {
          throw new ApiProblem(409, { code: 'CAPACITY_UNAVAILABLE' });
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('That time is no longer free. Suggest another time.')).toBeTruthy();
  });

  it('cancels a request with the chosen reason', async () => {
    const requested = appt({ status: 'requested', proposed_start_at: null, proposed_end_at: null, allowed_transitions: ['cancelled'] });
    const {
      api: { calls },
    } = renderApp(<AppointmentDetail appointmentId={ID} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...reads(requested),
        'appointments.transition': () => ({ ...requested, status: 'cancelled', cancelled_by: 'requester', allowed_transitions: [] }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fixed elsewhere' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'appointments.transition')).toBe(true));
    expect(calls.find((c) => c.opId === 'appointments.transition')!.args.body).toEqual({
      to: 'cancelled',
      cancellation_reason: 'Fixed elsewhere',
    });
    expect(await screen.findByText('Cancelled by you', { selector: 'h1' })).toBeTruthy();
  });

  it('shows "Triage: not provided" when the request came without Help Me', async () => {
    renderApp(<AppointmentDetail appointmentId={ID} />, {
      locale: 'en',
      session: signedIn(),
      handlers: reads(appt({ status: 'requested', triage_status: 'not_provided', allowed_transitions: ['cancelled'] })),
    });
    expect(await screen.findByText('Triage: not provided — the shop sees your own description.')).toBeTruthy();
  });
});

describe('appointment list', () => {
  it('pins what needs the user above the segments', async () => {
    navigation.reset('/en/appointments');
    renderApp(<AppointmentsScreen selectedId={null} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'appointments.list': (args) => {
          const group = (args.query as { group: string }).group;
          return { items: group === 'requested' ? [appt()] : [], next_cursor: null };
        },
      },
    });
    const needs = await screen.findByRole('heading', { name: 'Needs your action' });
    expect(within(needs.closest('section')!).getByText('New time proposed', { selector: '.pwa-appt-need' })).toBeTruthy();
    expect(await screen.findByText('No upcoming visits')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Requested' }));
    expect(navigation.search).toBe('seg=requested');
  });
});

describe('check-in link', () => {
  beforeEach(() => {
    forgetFragmentTokens();
    window.history.replaceState(null, '', '/l/ci#tok_abcdefgh123');
  });

  it('checks in only when the user says so, and removes the token from the address bar', async () => {
    const {
      api: { calls },
    } = renderApp(<CheckInLinkPage />, {
      locale: 'en',
      session: guest,
      handlers: { 'appointments.check_in_link': () => ({ appointment_id: ID, status: 'checked_in' }) },
    });
    const button = await screen.findByRole('button', { name: 'I’ve arrived' });
    expect(window.location.hash).toBe('');
    expect(calls).toHaveLength(0);
    fireEvent.click(button);
    expect(await screen.findByText('You’re checked in')).toBeTruthy();
    expect(calls[0]).toMatchObject({ opId: 'appointments.check_in_link', args: { body: { token: 'tok_abcdefgh123' } } });
  });

  it('explains the check-in window and an expired link', async () => {
    let answer: ApiProblem = new ApiProblem(409, { code: 'INVALID_TRANSITION', detail: 'outside_window' });
    renderApp(<CheckInLinkPage />, {
      locale: 'en',
      session: guest,
      handlers: {
        'appointments.check_in_link': () => {
          throw answer;
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'I’ve arrived' }));
    expect(await screen.findByText(/Check-in is open from 2 hours before/)).toBeTruthy();
    answer = new ApiProblem(410, { code: 'LINK_EXPIRED' });
    fireEvent.click(screen.getByRole('button', { name: 'I’ve arrived' }));
    expect(await screen.findByText('This check-in link has expired')).toBeTruthy();
  });
});

describe('notification actions', () => {
  it('accepts a proposed time from the notification and marks it read', async () => {
    const n: Notification = {
      id: 'n1',
      event_type: 'appointment_alternative_proposed',
      category: 'appointments',
      priority: 'normal',
      template_key: 'appointment.alternative_proposed',
      template_params: {},
      locale: 'en',
      organization_context_id: null,
      reference: { type: 'appointment', id: ID },
      read_at: null,
      created_at: '2026-10-30T08:00:00Z',
    };
    const {
      api: { calls },
    } = renderApp(<NotificationItem n={n} onOpen={() => undefined} />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'appointments.transition': () => appt({ status: 'confirmed' }), 'notifications.mark_read': () => ({ ok: true }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept time' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'notifications.mark_read')).toBe(true));
    expect(calls[0]).toMatchObject({ opId: 'appointments.transition', args: { body: { to: 'confirmed' } } });
  });
});
