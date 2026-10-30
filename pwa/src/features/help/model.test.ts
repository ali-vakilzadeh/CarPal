// P10.T1-T3 (unit): entry links, urgency (the server's safety block wins), the step after the description, the
// answers and their replay, confidence, the recommended three, the request body with and without triage, the reuse of
// the preview draft and what each failed send means.
import type { ResultCard, TriageSession } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api/problem';
import {
  answersOf,
  caseLevel,
  composeText,
  confidenceOf,
  createBody,
  descriptionOf,
  draftMatches,
  formErrors,
  maxLevel,
  newCase,
  parseEntry,
  recommended,
  replayTexts,
  requestFailure,
  safetyLevel,
  sourceOf,
  stepAfterStart,
  stepsOf,
  tooShort,
  type RequestForm,
} from './model';

const ORG = '0195f3b1-6a2b-7c3d-8e4f-000000000001';
const LOC = '0195f3b1-6a2b-7c3d-8e4f-000000000002';
const VEH = '0195f3b1-6a2b-7c3d-8e4f-000000000003';
const NONE = { flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false } as const;

function session(o: Partial<TriageSession> = {}): TriageSession {
  return {
    id: 't1',
    vehicle_id: VEH,
    issue_id: null,
    locale: 'fa',
    turns: [
      { role: 'user', text: 'Clunk over bumps', at: 'a' },
      { role: 'assistant', text: 'When does it happen?', at: 'b' },
      { role: 'user', text: 'Over bumps', at: 'c' },
      { role: 'assistant', text: 'Does the steering feel loose?', at: 'd' },
      { role: 'user', text: 'No', at: 'e' },
      { role: 'assistant', text: 'Thanks', at: 'f' },
    ],
    status: 'completed',
    safety: { ...NONE, do_not_drive: false },
    urgency_level: 'medium',
    symptoms: [{ node_id: 'sym1', label: { text: 'Clunking over bumps', locale: 'en' } }],
    likely_systems: [{ node_id: 'sys1', label: { text: 'Suspension', locale: 'en' } }],
    recommended_service: { node_id: 'task1', label: { text: 'Suspension inspection', locale: 'en' } },
    next_question: null,
    result_insight_id: 'ins1',
    match_session_id: 'm1',
    appointment_draft_id: null,
    ...o,
  };
}

describe('entry links', () => {
  it('reads the request hand-over of profiles, search, the map and favourites', () => {
    const e = parseEntry(
      new URLSearchParams({ provider: ORG.toUpperCase(), location: LOC, slot: '2026-11-01T06:00:00Z', shop: 'reza-auto', via: 'profile' }),
    );
    expect(e.provider).toEqual({ orgId: ORG, slug: 'reza-auto', locationId: LOC, slot: '2026-11-01T06:00:00.000Z', via: 'profile' });
  });

  it('drops anything malformed and defaults the source to search', () => {
    const e = parseEntry(new URLSearchParams({ provider: ORG, location: 'x', slot: 'tomorrow', shop: '<b>', via: 'evil' }));
    expect(e.provider).toEqual({ orgId: ORG, slug: null, locationId: null, slot: null, via: 'search' });
    expect(parseEntry(new URLSearchParams({ provider: 'nope' })).provider).toBeNull();
    expect(parseEntry(new URLSearchParams({ vehicle: VEH, issue: 'x', urgent: '1' }))).toMatchObject({
      vehicleId: VEH,
      issueId: null,
      urgent: true,
    });
  });

  it('has the short step list for requests without Help Me', () => {
    expect(stepsOf({ kind: 'direct' })).toEqual(['request', 'done']);
    expect(stepsOf({ kind: 'help' })).toHaveLength(6);
  });
});

describe('urgency and safety', () => {
  it('takes the highest level', () => {
    expect(maxLevel('low', null, 'high', 'medium')).toBe('high');
    expect(maxLevel(null, undefined)).toBeNull();
  });

  it('lets the server safety block raise but never lower the level', () => {
    const urgent = { ...NONE, flag: true, level: 'urgent' as const, urgent_help_available: true };
    expect(safetyLevel(urgent)).toBe('high');
    expect(safetyLevel({ ...urgent, do_not_drive: true })).toBe('safety_critical');
    expect(caseLevel({ urgency: 'ok', safety: urgent })).toBe('high');
    expect(caseLevel({ urgency: 'unsafe', safety: null })).toBe('safety_critical');
    expect(caseLevel({ urgency: null, safety: null }, session({ status: 'escalated_safety', urgency_level: 'medium' }))).toBe(
      'safety_critical',
    );
    expect(caseLevel({ urgency: null, safety: null })).toBe('medium');
  });

  it('interrupts for safety-critical cases, else asks questions while there are any', () => {
    expect(stepAfterStart('safety_critical', { next_question: 'Q?' })).toBe('safety');
    expect(stepAfterStart('medium', { next_question: 'Q?' })).toBe('questions');
    expect(stepAfterStart('medium', { next_question: null })).toBe('safety');
    expect(stepAfterStart('low', null)).toBe('safety');
  });
});

describe('triage', () => {
  it('adds the symptom shortcuts to the description and asks for enough detail', () => {
    expect(composeText(' Knock ', ['Noise', 'Brakes'])).toBe('Knock\nNoise، Brakes');
    expect(composeText('', ['Noise'])).toBe('Noise');
    expect(tooShort('noise')).toBe(true);
    expect(tooShort('a knock at the front')).toBe(false);
  });

  it('pairs the answers with the questions before them and replays up to an edited one', () => {
    const s = session();
    expect(descriptionOf(s)).toBe('Clunk over bumps');
    expect(answersOf(s)).toEqual([
      { question: 'When does it happen?', answer: 'Over bumps', index: 0 },
      { question: 'Does the steering feel loose?', answer: 'No', index: 1 },
    ]);
    expect(replayTexts(s, 1, 'Yes, a little')).toEqual({ start: 'Clunk over bumps', replies: ['Over bumps', 'Yes, a little'] });
    expect(replayTexts(s, 0, 'Only when turning')).toEqual({ start: 'Clunk over bumps', replies: ['Only when turning'] });
  });

  it('derives confidence from the likely areas', () => {
    expect(confidenceOf(session({ likely_systems: [] }))).toBe('low');
    expect(confidenceOf(session())).toBe('high');
    expect(
      confidenceOf(
        session({ likely_systems: [...session().likely_systems, { node_id: 's2', label: { text: 'Steering', locale: 'en' } }] }),
      ),
    ).toBe('medium');
  });
});

describe('recommendations', () => {
  const card = (rank: number, o: Partial<ResultCard> = {}): ResultCard =>
    ({
      result_id: `r${rank}`,
      rank,
      target: { type: 'organization', id: `o${rank}` },
      organization: { id: `o${rank}`, roles: ['provider'] },
      open_now: null,
      next_available_slot: null,
      ...o,
    }) as unknown as ResultCard;

  it('keeps providers in rank order and splits the top three', () => {
    const vendor = card(2, { organization: { id: 'v', roles: ['vendor'] } as ResultCard['organization'] });
    const r = recommended([card(4), card(1), vendor, card(3), card(5)], false);
    expect(r.top.map((x) => x.rank)).toEqual([1, 3, 4]);
    expect(r.more.map((x) => x.rank)).toEqual([5]);
  });

  it('puts shops open now, then the soonest opening, first when safety-critical', () => {
    const r = recommended(
      [
        card(1),
        card(2, { next_available_slot: '2026-11-02T06:00:00Z' }),
        card(3, { open_now: true }),
        card(4, { next_available_slot: '2026-11-01T06:00:00Z' }),
      ],
      true,
    );
    expect(r.top.map((x) => x.rank)).toEqual([3, 4, 2]);
  });
});

describe('the request', () => {
  const form = (o: Partial<RequestForm> = {}): RequestForm => ({
    vehicleId: VEH,
    description: 'Clunk from the front right over bumps',
    categoryId: null,
    appointmentType: 'diagnosis',
    serviceMode: 'in_shop',
    urgency: 'medium',
    note: '  ',
    channel: 'in_app',
    share: false,
    includeMedia: true,
    mediaIds: [],
    windows: [{ start_at: '2026-11-01T06:00:00Z', end_at: '2026-11-01T07:00:00Z', priority: 1 }],
    ...o,
  });
  const provider = { orgId: ORG, slug: 'reza', name: 'Reza', locationId: LOC, slot: null, resultId: 'res1', via: 'help' as const };
  const o = { locale: 'fa' as const, policyVersion: '2026-10', submit: true };

  it('sends a Help Me request with the triage, its issue, symptom, service and the match result', () => {
    const c = newCase('c1', { provider, triageId: 't1' });
    const b = createBody(c, form({ share: true, mediaIds: ['m1', 'm1', 'm2'] }), { ...o, triage: session({ issue_id: 'i1' }) });
    expect(b).toMatchObject({
      provider_organization_id: ORG,
      provider_location_id: LOC,
      vehicle_id: VEH,
      source: 'ai_match',
      triage_session_id: 't1',
      related_issue_id: 'i1',
      symptom_node_id: 'sym1',
      service_task_node_id: 'task1',
      service_system_node_id: 'sys1',
      match_result_id: 'res1',
      share_history: { policy_version: '2026-10' },
      media_ids: ['m1', 'm2'],
      content_locale: 'fa',
      submit: true,
    });
    expect(b).not.toHaveProperty('customer_expectations');
  });

  it('leaves out the triage while it is still open and sends no history without consent', () => {
    const b = createBody(newCase('c1', { provider }), form(), { ...o, triage: session({ status: 'in_progress' }) });
    expect(b).not.toHaveProperty('triage_session_id');
    expect(b).not.toHaveProperty('share_history');
    expect(b.service_system_node_id).toBe('sys1');
  });

  it('is a plain request without Help Me: the source follows the entry, the category is optional', () => {
    const direct = newCase('c2', { kind: 'direct', provider: { ...provider, via: 'profile', resultId: null } });
    const b = createBody(direct, form({ note: ' Keep it for the day ', includeMedia: false, mediaIds: ['m1'] }), { ...o, triage: null });
    expect(b.source).toBe('review_profile');
    expect(b).not.toHaveProperty('service_system_node_id');
    expect(b).not.toHaveProperty('match_result_id');
    expect(b).not.toHaveProperty('media_ids');
    expect(b.customer_expectations).toBe('Keep it for the day');
    expect(sourceOf({ kind: 'direct', provider: { ...provider, via: 'saved' } }, 'sys')).toBe('direct_search');
    expect(sourceOf({ kind: 'help', provider }, null)).toBe('direct_search');
  });

  it('reuses the preview draft only while its fixed parts are the same', () => {
    const d = { id: 'a1', version: 2, share: true, providerId: ORG, vehicleId: VEH, source: 'ai_match' as const };
    expect(draftMatches(d, { provider_organization_id: ORG, vehicle_id: VEH, source: 'ai_match', share: true })).toBe(true);
    expect(draftMatches(d, { provider_organization_id: ORG, vehicle_id: VEH, source: 'ai_match', share: false })).toBe(false);
    expect(draftMatches(null, { provider_organization_id: ORG, vehicle_id: VEH, source: 'ai_match', share: true })).toBe(false);
  });

  it('needs a car, a description and, to send, a time', () => {
    expect(formErrors(form({ vehicleId: null, description: 'short', windows: [] }), true)).toEqual(['vehicle', 'description', 'times']);
    expect(formErrors(form({ windows: [] }), false)).toEqual([]);
  });

  it('explains each failed send', () => {
    const p = (status: number, body: Record<string, unknown>) => new ApiProblem(status, body);
    expect(requestFailure(p(429, { code: 'RATE_LIMITED' }))).toBe('caps');
    expect(requestFailure(p(403, { code: 'VERIFIED_CONTACT_REQUIRED' }))).toBe('contact');
    expect(requestFailure(p(409, { code: 'CAPACITY_UNAVAILABLE' }))).toBe('capacity');
    expect(requestFailure(p(412, { code: 'VERSION_MISMATCH' }))).toBe('stale');
    expect(requestFailure(p(0, {}))).toBe('network');
    expect(requestFailure(p(422, { code: 'VALIDATION_FAILED', errors: [{ pointer: '/time_windows/0/start_at', code: 'in_past' }] }))).toBe(
      'times',
    );
    expect(requestFailure(p(422, { code: 'VALIDATION_FAILED', errors: [{ pointer: '/description', code: 'too_short' }] }))).toBe(
      'description',
    );
    expect(
      requestFailure(
        p(422, { code: 'REFERENCE_NOT_FOUND', errors: [{ pointer: '/provider_organization_id', code: 'reference_not_found' }] }),
      ),
    ).toBe('provider');
    expect(requestFailure(new Error('x'))).toBe('error');
  });
});
