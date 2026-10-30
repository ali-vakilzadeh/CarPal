// P10.T1-T3 (DOM): Help Me — Start runs triage.start and goes to the step the session asks for; AI off (503 with the
// safety block) goes to Safety on the category path; a guest's Start opens the sign-in context modal; the request
// step of a request without triage sends appointments.create with the profile's slot, explains the caps answer
// without retrying, and the preview saves a draft and shows what the shop receives ("Triage: not provided").
import type { Appointment, PreVisitReport, PublicOrgProfile, Vehicle } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { guest, renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { ApiProblem } from '@/lib/api/problem';
import { HelpEntry } from './describe';
import { newCase, type HelpCase } from './model';
import { HelpWizard } from './wizard';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const ORG = '0195f3b1-6a2b-7c3d-8e4f-000000000001';
const LOC = '0195f3b1-6a2b-7c3d-8e4f-000000000002';
const VEH = '0195f3b1-6a2b-7c3d-8e4f-000000000003';
const CASE = '0195f3b1-6a2b-7c3d-8e4f-000000000004';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const vehicle = { id: VEH, status: 'active', brand_node_id: 'b1', model_node_id: 'm1', nickname: 'Silver' } as unknown as Vehicle;
const tomorrow = new Date(Date.now() + 86_400_000);
tomorrow.setUTCHours(6, 0, 0, 0);
const slotStart = tomorrow.toISOString();
const slot = {
  start_at: slotStart,
  end_at: new Date(tomorrow.getTime() + 3_600_000).toISOString(),
  location_id: LOC,
  appointment_types: [],
};

const profile = {
  id: ORG,
  slug: 'reza-auto',
  name: 'Reza Auto Suspension',
  organization_type: 'provider',
  roles: ['provider'],
  verified: true,
  overall_rating: '4.8',
  review_count: 12,
  top_badges: [],
  locations: [
    {
      id: LOC,
      name: null,
      point: { lat: 35.7, lng: 51.4 },
      visibility: 'exact',
      address: { address_line_1: '14 Sattarkhan St', city: 'Tehran', region: null, country: 'IR' },
      service_radius_km: null,
      hours: null,
      open_now: null,
      timezone: 'Asia/Tehran',
      access_instructions: null,
    },
  ],
  provider: { service_modes: ['in_shop'] },
} as unknown as PublicOrgProfile;

const appointment = (o: Partial<Appointment> = {}) => ({ id: 'a1', version: 1, status: 'requested', ...o }) as Appointment;

function seed(c: HelpCase) {
  localStorage.setItem('cp:help:cases:u1', JSON.stringify([c]));
}

const base: Handlers = {
  'vehicles.list': () => ({ items: [vehicle], next_cursor: null }),
  'taxonomy.snapshot': () => ({ items: [], next_cursor: null }),
  'safety.check': () => ({ flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false }),
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(String(input) === '/bff/csrf' ? json({ csrf_token: 'c' }) : json({}, 404))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Help Me landing', () => {
  it('starts the guided help and goes to the questions', async () => {
    navigation.reset('/en/help');
    const {
      api: { calls },
    } = renderApp(<HelpEntry />, {
      locale: 'en',
      session: signedIn(),
      flags: { 'ai.triage.enabled': true },
      handlers: {
        ...base,
        'triage.start': () => ({
          id: 't1',
          turns: [],
          status: 'in_progress',
          safety: { flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false, do_not_drive: false },
          urgency_level: 'medium',
          next_question: 'When does it happen?',
          likely_systems: [],
          symptoms: [],
        }),
      },
    });
    fireEvent.change(await screen.findByLabelText('Describe the problem'), { target: { value: 'A clunk from the front over bumps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Noise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided help' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/en\/help\/[0-9a-f-]{36}\/questions$/)));
    const start = calls.find((c) => c.opId === 'triage.start')!;
    expect(start.args.body).toMatchObject({ vehicle_id: VEH, locale: 'en', text: 'A clunk from the front over bumps\nNoise' });
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]).toMatchObject({ triageId: 't1', step: 'questions', vehicleId: VEH, aiOff: false });
  });

  it('keeps the safety block of a 503 and goes on to the category path', async () => {
    navigation.reset('/en/help');
    renderApp(<HelpEntry />, {
      locale: 'en',
      session: signedIn(),
      flags: { 'ai.triage.enabled': true },
      handlers: {
        ...base,
        'triage.start': () => {
          throw new ApiProblem(503, {
            code: 'AI_UNAVAILABLE',
            safety: { flag: true, level: 'urgent', message_i18n_key: null, urgent_help_available: true },
            fallback_path: '/v1/search',
          });
        },
      },
    });
    fireEvent.change(await screen.findByLabelText('Describe the problem'), { target: { value: 'Brakes feel soft since yesterday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start guided help' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/\/safety$/)));
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]).toMatchObject({ aiOff: true, triageId: null, safety: { level: 'urgent' } });
  });

  it('asks a guest to sign in before starting', async () => {
    navigation.reset('/en/help');
    const {
      api: { calls },
    } = renderApp(<HelpEntry />, { locale: 'en', session: guest, flags: { 'ai.triage.enabled': true }, handlers: base });
    fireEvent.change(await screen.findByLabelText('Describe the problem'), { target: { value: 'A clunk from the front over bumps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start guided help' }));
    expect(await screen.findByText('Sign in to get help with your car')).toBeTruthy();
    expect(calls.some((c) => c.opId === 'triage.start')).toBe(false);
  });

  it('hands a request link over to the request step of a new case', async () => {
    navigation.reset(`/en/help?provider=${ORG}&location=${LOC}&shop=reza-auto&via=profile`);
    renderApp(<HelpEntry />, { locale: 'en', session: signedIn(), handlers: base });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/en\/help\/[0-9a-f-]{36}\/request$/)));
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]).toMatchObject({ kind: 'direct', provider: { orgId: ORG, slug: 'reza-auto', locationId: LOC, via: 'profile' } });
  });
});

describe('the request step', () => {
  const direct = () =>
    newCase(CASE, {
      kind: 'direct',
      step: 'request',
      vehicleId: VEH,
      provider: { orgId: ORG, slug: 'reza-auto', name: null, locationId: LOC, slot: slotStart, resultId: null, via: 'search' },
    });
  const wizard = (handlers: Handlers) =>
    renderApp(<HelpWizard caseId={CASE} step="request" defaultCity="tehran" styleUrl={null} policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...base,
        'public.org_get': () => profile,
        'public.availability': () => ({ slots: [slot] }),
        ...handlers,
      },
    });

  it('sends the request with the slot picked on the profile', async () => {
    navigation.reset(`/en/help/${CASE}/request`);
    seed(direct());
    const {
      api: { calls },
    } = wizard({ 'appointments.create': () => appointment() });
    fireEvent.change(await screen.findByLabelText('What do you need?'), { target: { value: 'Front brake pads and an alignment' } });
    await screen.findByText('Choice 1');
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/en/help/${CASE}/done`));
    const body = calls.find((c) => c.opId === 'appointments.create')!.args.body as Record<string, unknown>;
    expect(body).toMatchObject({
      provider_organization_id: ORG,
      provider_location_id: LOC,
      vehicle_id: VEH,
      source: 'direct_search',
      service_mode: 'in_shop',
      submit: true,
      description: 'Front brake pads and an alignment',
      time_windows: [{ start_at: slotStart, priority: 1 }],
    });
    expect(body).not.toHaveProperty('triage_session_id');
    expect(body).not.toHaveProperty('share_history');
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]!.appointmentId).toBe('a1');
  });

  it('explains the open-request caps in one message and does not retry', async () => {
    navigation.reset(`/en/help/${CASE}/request`);
    seed(direct());
    const {
      api: { calls },
    } = wizard({
      'appointments.create': () => {
        throw new ApiProblem(429, { code: 'RATE_LIMITED', retry_after_ms: 3_600_000 });
      },
    });
    fireEvent.change(await screen.findByLabelText('What do you need?'), { target: { value: 'Front brake pads and an alignment' } });
    await screen.findByText('Choice 1');
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/up to 3 with one shop and 10 in all/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See your open requests' })).toBeTruthy();
    expect(calls.filter((c) => c.opId === 'appointments.create')).toHaveLength(1);
  });

  it('previews what the shop receives through a draft', async () => {
    navigation.reset(`/en/help/${CASE}/request`);
    seed(direct());
    const report = {
      id: 'p1',
      appointment_id: 'a1',
      vehicle_summary: 'BMW 320i 2012',
      mileage_km: null,
      reported_symptoms: [],
      triage_status: 'not_provided',
      issue_summary: 'Front brake pads and an alignment',
      ai_summary: null,
      ai_summary_status: 'not_required',
      likely_services: [],
      relevant_history_summary: null,
      previous_related_repairs: null,
      shared_documents: null,
      known_warnings: [],
      suggested_focus_areas: [],
      media: [],
      customer_expectations: null,
      urgency_level: 'medium',
      fleet_approval_status: null,
      preferred_contact_channel: 'in_app',
      generated_at: null,
      status: 'draft',
    } as unknown as PreVisitReport;
    const {
      api: { calls },
    } = wizard({ 'appointments.create': () => appointment({ status: 'draft' }), 'pre_visit.requester_get': () => report });
    fireEvent.change(await screen.findByLabelText('What do you need?'), { target: { value: 'Front brake pads and an alignment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview what the shop receives' }));
    expect(await screen.findByText('Triage: not provided')).toBeTruthy();
    expect(screen.getByText(/this is what Reza Auto Suspension will receive/)).toBeTruthy();
    expect((calls.find((c) => c.opId === 'appointments.create')!.args.body as { submit: boolean }).submit).toBe(false);
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]!.draft).toMatchObject({ id: 'a1', share: false, providerId: ORG });
  });
});

describe('recommendations', () => {
  const triage = (status: 'in_progress' | 'completed') => ({
    id: 't1',
    vehicle_id: VEH,
    issue_id: status === 'completed' ? 'i1' : null,
    locale: 'en',
    turns: [{ role: 'user', text: 'Clunk over bumps', at: '2026-10-30T08:00:00Z' }],
    status,
    safety: { flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false, do_not_drive: false },
    urgency_level: 'medium',
    symptoms: [{ node_id: 'sym1', label: { text: 'Clunking over bumps', locale: 'en' } }],
    likely_systems: [{ node_id: 'sys1', label: { text: 'Suspension', locale: 'en' } }],
    recommended_service: null,
    next_question: null,
    result_insight_id: null,
    match_session_id: null,
    appointment_draft_id: null,
  });
  const result = {
    result_id: 'r1',
    rank: 1,
    target: { type: 'organization', id: ORG },
    organization: { ...profile, price_tier: null, measured_response_time_minutes: null, logo_url: null, portfolio_thumbnail_url: null },
    item: null,
    location: { location_id: LOC, point: { lat: 35.7, lng: 51.4 }, visibility: 'exact', service_radius_km: null, city: 'Tehran' },
    distance_km: '1.2',
    match_score: '0.9',
    confidence: 'high',
    reasons: [{ reason_type: 'specialist', summary: { text: 'Specialist in suspension for your car', locale: 'en' } }],
    explanation: { text: 'Recommended because of 18 verified suspension jobs.', source: 'template' },
    relevant_to_vehicle: true,
    matching_item_count: null,
    next_available_slot: null,
    open_now: true,
    is_sponsored: false,
  };

  it('searches with the triage chips when the session was completed meanwhile, and requests from a card', async () => {
    navigation.reset(`/en/help/${CASE}/recommendations`);
    seed(newCase(CASE, { step: 'recommendations', vehicleId: VEH, triageId: 't1', text: 'Clunk over bumps' }));
    let completed = false;
    const {
      api: { calls },
    } = renderApp(<HelpWizard caseId={CASE} step="recommendations" defaultCity="tehran" styleUrl={null} policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...base,
        'triage.get': () => triage(completed ? 'completed' : 'in_progress'),
        'triage.complete': () => {
          completed = true;
          throw new ApiProblem(409, { code: 'INVALID_TRANSITION', detail: 'session_closed' });
        },
        'search.run': () => ({
          session_id: 's1',
          results: [result],
          safety: { flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false },
        }),
        'search.result_event': () => ({ ok: true }),
      },
    });
    expect((await screen.findAllByText('Recommended because of 18 verified suspension jobs.')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Specialist in suspension for your car').length).toBeGreaterThan(0);
    const run = calls.find((c) => c.opId === 'search.run')!.args.body as {
      entry_point: string;
      intent_override: { chips: { kind: string; node_id: string }[] };
    };
    expect(run.entry_point).toBe('help_me');
    expect(run.intent_override.chips.map((x) => `${x.kind}:${x.node_id}`)).toEqual(['symptom:sym1', 'service_system:sys1']);
    fireEvent.click(screen.getByRole('button', { name: 'Request appointment' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/en/help/${CASE}/request`));
    const stored = JSON.parse(localStorage.getItem('cp:help:cases:u1')!) as HelpCase[];
    expect(stored[0]!.provider).toMatchObject({ orgId: ORG, slug: 'reza-auto', locationId: LOC, resultId: 'r1', via: 'help' });
    expect(stored[0]!.matchSessionId).toBe('s1');
  });
});
