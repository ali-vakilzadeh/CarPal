// S7 appointments (40 §16, public.availability) and the trust loop (40 §15):
// acceptance — two concurrent confirmations of the last slot give one 200 and
// one 409 CAPACITY_UNAVAILABLE; request → confirm → check-in → complete →
// service record → Path 1 review → published → trust score and capability
// evidence updated; internal notes never reach the requester. Also the
// requester transitions, open slots, the consent-gated pre-visit report and
// record-level BOLA.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafetyLexicon } from '#libs/safety-check/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { newId, outbox } from './s5-support.js';
import { flush, publishedProvider } from './s6-support.js';
import { customer, localDay, provider, requestBody, requested, rule, window } from './s7-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

const iso = (d: Date) => d.toISOString();

describe('capacity (S7 acceptance)', () => {
  it('two concurrent confirmations for the last slot: one succeeds, one gets CAPACITY_UNAVAILABLE', async () => {
    const p = await publishedProvider(app, n, { name: `Slot Garage ${newId().slice(-6)}` });
    const day = localDay(3);
    await rule(p, day.dayOfWeek);
    const [a, b] = await Promise.all([customer(app, n), customer(app, n)]);
    const ra = await requested(p, a, n);
    const rb = await requested(p, b, n);
    const start = day.at('10:00');
    const confirm = (id: string) =>
      p.c.post(provider(p, `/${id}/transitions`), {
        to: 'confirmed',
        confirmed_start_at: iso(start),
        confirmed_end_at: iso(new Date(start.getTime() + 3_600_000)),
      });
    const results = await Promise.all([confirm(ra.id), confirm(rb.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('CAPACITY_UNAVAILABLE');
    // The slot is gone from the public availability; the next hour is still open.
    const anon = await app.fixtures.anonymousToken();
    const slots = await app.request<Json>({
      path: `/v1/public/orgs/${p.id}/availability?location_id=${p.locationId}&from=${day.date}&days=1`,
      token: anon,
    });
    expect(slots.status).toBe(200);
    const starts = (slots.body.slots as Json[]).map((s) => s.start_at);
    expect(starts).not.toContain(iso(start));
    expect(starts).toContain(iso(new Date(start.getTime() + 3_600_000)));
    // Outside the rule's hours there is no capacity at all.
    const night = day.at('20:00');
    const loser = results[0]!.status === 409 ? ra : rb;
    const late = await p.c.post(provider(p, `/${loser.id}/transitions`), { to: 'confirmed', confirmed_start_at: iso(night) });
    expect(late.body.code).toBe('CAPACITY_UNAVAILABLE');
  });
});

describe('the trust loop (S7 acceptance)', () => {
  it('request → confirm → check-in → complete → service record → Path 1 review → published → trust score and evidence', async () => {
    const p = await publishedProvider(app, n, { name: `Loop Garage ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const created = await cu.c.post('/v1/me/appointments', requestBody(p, cu, n, { share_history: { policy_version: '2026-10' } }));
    expect(created.status).toBe(201);
    const a = created.body;
    expect(a).toMatchObject({
      status: 'requested',
      requester_type: 'user',
      triage_status: 'not_provided',
      consent_to_share_history: true,
      provider_location_exact: null,
      can_review: false,
      allowed_transitions: ['cancelled'],
      provider: { id: p.id },
      provider_location: { id: p.locationId },
    });
    expect((await outbox(app, a.id)).map((e) => e.type)).toContain('appointment.requested');

    // Provider side: new request, no contact before confirmation.
    const inbox = await p.c.get(provider(p, '?group=new'));
    expect(inbox.body.items.map((x: Json) => x.id)).toContain(a.id);
    const before = await p.c.get(provider(p, `/${a.id}`));
    expect(before.body).toMatchObject({ requester_contact: null, provider_location_exact: null, can_review: false });
    expect(before.headers['cache-control']).toBe('no-store');

    // Confirm one hour from now (no calendar: only time off blocks); the ci link is mailed to the requester.
    const start = new Date(Date.now() + 3_600_000);
    const confirmed = await p.c.post(provider(p, `/${a.id}/transitions`), {
      to: 'confirmed',
      confirmed_start_at: iso(start),
      estimated_duration_minutes: 90,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'confirmed', confirmed_start_at: iso(start) });
    expect((await p.c.get(provider(p, `/${a.id}`))).body.requester_contact).toEqual({ channel: 'email', value: cu.user.email });
    const mine = await cu.c.get(`/v1/me/appointments/${a.id}`);
    expect(mine.body.provider_location_exact).toMatchObject({ address_line_1: '7 Desert Road' });
    expect(mine.body.requester_contact).toBeNull();
    const mail = app.mail(cu.user.email, 'appointment.check_in_link').at(-1)!;
    const token = mail.variables.link!.split('#')[1]!;

    // Check in from the link without signing in (within ±2 h of the start).
    const anonymous = await app.fixtures.anonymousToken();
    const checkIn = await app.request<Json>({ method: 'POST', path: '/v1/check-in', token: anonymous, body: { token } });
    expect(checkIn.status).toBe(200);
    expect(checkIn.body).toEqual({ appointment_id: a.id, status: 'checked_in' });
    expect(
      (await app.request<Json>({ method: 'POST', path: '/v1/check-in', token: anonymous, body: { token: 'cp_ci_' + 'A'.repeat(43) } })).body
        .code,
    ).toBe('LINK_EXPIRED');

    expect((await p.c.post(provider(p, `/${a.id}/transitions`), { to: 'in_progress' })).status).toBe(200);
    const done = await p.c.post(provider(p, `/${a.id}/transitions`), {
      to: 'completed',
      final_cost: { amount: '1200000', currency: 'IRR' },
      service_record: { service_system_node_id: n.system, description: 'Replaced front pads', mileage_km: 81000 },
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.service_record_id).toBeTruthy();
    const record = await cu.c.get(`/v1/me/vehicles/${cu.vehicleId}/service-records/${done.body.service_record_id}`);
    expect(record.body).toMatchObject({
      source_type: 'appointment_completed',
      verification_status: 'appointment_verified',
      appointment_id: a.id,
    });
    const history = await cu.c.get(`/v1/me/appointments/${a.id}/history`);
    expect(history.body.items.map((h: Json) => h.new_status)).toEqual(['requested', 'confirmed', 'checked_in', 'in_progress', 'completed']);

    // W4: the system invitation; the requester can now review (Path 1).
    await flush(app, worker);
    const invitations = await cu.c.get('/v1/me/review-invitations');
    expect(invitations.body.items).toHaveLength(1);
    expect(invitations.body.items[0]).toMatchObject({ visit: { type: 'appointment', id: a.id }, channel: 'in_app', status: 'sent' });
    expect((await cu.c.get(`/v1/me/appointments/${a.id}`)).body.can_review).toBe(true);
    const eligibility = await cu.c.post('/v1/reviews/eligibility', { subject_organization_id: p.id });
    expect(eligibility.body).toMatchObject({ allowed: true, path: 'visit_based', reason_code: 'ok' });
    expect(eligibility.body.candidate_visits).toEqual([
      expect.objectContaining({ type: 'appointment', id: a.id, within_invitation_window: true }),
    ]);

    const review = await cu.c.post('/v1/reviews', {
      subject_organization_id: p.id,
      subject_type: 'provider',
      context_appointment_id: a.id,
      overall_rating: 5,
      would_return: true,
      body: 'Quick and honest brake job, explained everything.',
      content_locale: 'en',
      sub_ratings: [
        { dimension: 'work_quality', rating: 5 },
        { dimension: 'communication', rating: 5 },
      ],
    });
    expect(review.status).toBe(201);
    expect(review.body).toMatchObject({
      status: 'pending_moderation',
      confirmation_path: 'visit_based',
      verified_status: 'appointment_verified',
      business_confirmation_status: null,
      reviewer_decision: null,
      context_vehicle_id: cu.vehicleId,
      service_system_node_id: n.system,
    });
    expect(JSON.stringify(review.body)).not.toContain('trust_weight');
    const dup = await cu.c.post('/v1/reviews', {
      subject_organization_id: p.id,
      subject_type: 'provider',
      context_appointment_id: a.id,
      overall_rating: 4,
      body: 'A second review of the same visit.',
      content_locale: 'en',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');

    // W4 publishes it after the automatic checks; W3 scores the provider.
    await flush(app, worker);
    expect((await cu.c.get(`/v1/me/reviews/${review.body.id}`)).body).toMatchObject({ status: 'published' });
    const anon = await app.fixtures.anonymousToken();
    const pub = await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon });
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0]).toMatchObject({ label: 'verified_visit', overall_rating: 5, would_return: true });
    const facts = await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      const org = await db.selectFrom('organization.organizations').select('trust_score').where('id', '=', p.id).executeTakeFirstOrThrow();
      const { rows } = await sql<{ evidence_type: string; status: string; base_weight: number; confidence_level: string }>`
        SELECT e.evidence_type, e.status, e.base_weight, c.confidence_level
          FROM organization.provider_capability_evidence e JOIN organization.provider_capabilities c ON c.id = e.capability_id
         WHERE c.provider_organization_id = ${p.id}::uuid ORDER BY e.evidence_type`.execute(db);
      return { score: org.trust_score, evidence: rows };
    });
    expect(facts.score).not.toBeNull();
    expect(facts.evidence.map((e) => [e.evidence_type, e.status, Number(e.base_weight)])).toEqual([
      ['completed_appointment', 'active', 10],
      ['verified_review', 'active', 8],
    ]);
    // 10 × 1.5 + 8 × 1.5 = 27 → low_evidence.
    expect(facts.evidence[0]!.confidence_level).toBe('low_evidence');
    const signals = await p.c.get(`/v1/orgs/${p.id}/trust-signals`);
    const byType = Object.fromEntries((signals.body.items as Json[]).map((s) => [s.signal_type, s]));
    expect(byType.avg_star_rating).toMatchObject({ value: '5', is_public: true });
    expect(byType.overall_trust_score.value).toBe(String(facts.score));
    expect(byType.risk_fraud_flag).toBeUndefined();
    expect((await cu.c.get(`/v1/me/appointments/${a.id}`)).body.can_review).toBe(false);
  });
});

describe('notes and the requester side', () => {
  it('internal notes are never visible to the requester (S7 acceptance)', async () => {
    const name = `Note Garage ${newId().slice(-6)}`;
    const p = await publishedProvider(app, n, { name });
    const cu = await customer(app, n);
    const a = await requested(p, cu, n);
    expect(
      (
        await p.c.post(provider(p, `/${a.id}/notes`), {
          note_type: 'internal',
          body: 'Customer seems price sensitive',
          content_locale: 'en',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await p.c.post(provider(p, `/${a.id}/notes`), {
          note_type: 'customer_visible',
          body: 'Please bring the spare key',
          content_locale: 'en',
        })
      ).status,
    ).toBe(201);
    expect((await cu.c.post(`/v1/me/appointments/${a.id}/notes`, { body: 'Will be there at 10', content_locale: 'en' })).status).toBe(201);
    const requesterView = await cu.c.get(`/v1/me/appointments/${a.id}/notes`);
    expect(requesterView.body.items.map((x: Json) => x.body)).toEqual(['Please bring the spare key', 'Will be there at 10']);
    expect(requesterView.text).not.toContain('price sensitive');
    // Provider members appear to the requester under the business's name.
    expect(requesterView.body.items[0].author_display).toBe(name);
    const providerView = await p.c.get(provider(p, `/${a.id}/notes`));
    expect(providerView.body.items.map((x: Json) => x.note_type)).toEqual(['internal', 'customer_visible', 'customer_visible']);
  });

  it('drafts, edits, the alternative-time loop and cancellation follow the requester column of 40 §16.1', async () => {
    const p = await publishedProvider(app, n, { name: `Flow Garage ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const draft = await requested(p, cu, n, { submit: false, time_windows: [] });
    expect(draft).toMatchObject({ status: 'draft', allowed_transitions: ['requested', 'cancelled'] });
    // The provider does not see drafts.
    expect((await p.c.get(provider(p, `/${draft.id}`))).status).toBe(404);
    const preview = await cu.c.get(`/v1/me/appointments/${draft.id}/pre-visit-report`);
    expect(preview.body).toMatchObject({
      status: 'draft',
      triage_status: 'not_provided',
      ai_summary: null,
      relevant_history_summary: null,
    });
    expect((await cu.c.post(`/v1/me/appointments/${draft.id}/transitions`, { to: 'requested' })).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ pointer: '/time_windows', code: 'conditional_required' }],
    });
    const edited = await cu.c.patch(
      `/v1/me/appointments/${draft.id}`,
      { time_windows: [window(3)], description: 'Brakes squeal and the car pulls left.' },
      draft.version,
    );
    expect(edited.status).toBe(200);
    const sent = await cu.c.post(`/v1/me/appointments/${draft.id}/transitions`, { to: 'requested' });
    expect(sent.body.status).toBe('requested');
    expect((await outbox(app, draft.id)).map((e) => e.type)).toEqual(
      expect.arrayContaining(['appointment.requested', 'appointment.status_changed']),
    );

    const proposedStart = new Date(Date.now() + 4 * 86_400_000);
    const alt = await p.c.post(provider(p, `/${draft.id}/transitions`), {
      to: 'alternative_proposed',
      proposed_start_at: iso(proposedStart),
      proposed_end_at: iso(new Date(proposedStart.getTime() + 3_600_000)),
      note: 'We are full that day',
    });
    expect(alt.body).toMatchObject({ status: 'alternative_proposed', proposed_start_at: iso(proposedStart) });
    expect(
      (await cu.c.post(`/v1/me/appointments/${draft.id}/transitions`, { to: 'confirmed', confirmed_start_at: iso(proposedStart) })).body
        .code,
    ).toBe('VALIDATION_FAILED');
    const accepted = await cu.c.post(`/v1/me/appointments/${draft.id}/transitions`, { to: 'confirmed' });
    expect(accepted.body).toMatchObject({
      status: 'confirmed',
      confirmed_start_at: iso(proposedStart),
      allowed_transitions: ['cancelled', 'checked_in'],
    });
    // Check-in is refused far from the start; a delay notice needs a confirmed appointment.
    expect((await cu.c.post(`/v1/me/appointments/${draft.id}/check-in`)).body.code).toBe('INVALID_TRANSITION');
    const delayed = await cu.c.post(`/v1/me/appointments/${draft.id}/delay`, { customer_delay_minutes: 15 });
    expect(delayed.body.customer_delay_minutes).toBe(15);
    expect(
      (await cu.c.patch(`/v1/me/appointments/${draft.id}`, { description: 'Too late to edit now.' }, delayed.body.version)).body.code,
    ).toBe('INVALID_TRANSITION');
    const cancelled = await cu.c.post(`/v1/me/appointments/${draft.id}/transitions`, {
      to: 'cancelled',
      cancellation_reason: 'Fixed elsewhere',
    });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelled_by: 'requester', allowed_transitions: [] });
    expect((await p.c.post(provider(p, `/${draft.id}/transitions`), { to: 'in_progress' })).body.code).toBe('INVALID_TRANSITION');
    const list = await cu.c.get('/v1/me/appointments?group=cancelled');
    expect(list.body.items.map((x: Json) => x.id)).toContain(draft.id);
  });

  it('the safety check sets safety_flag; open-request caps apply per provider (SEC-BF-3)', async () => {
    const p = await publishedProvider(app, n, { name: `Cap Garage ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const critical = (await app.app.get(SafetyLexicon, { strict: false }).terms()).find((t) => t.urgency === 'safety_critical');
    const node = critical ? await app.app.get(TaxonomyResolver, { strict: false }).get(critical.nodeId) : null;
    const lexicon = node?.nameTranslations.en ?? null;
    const first = await requested(p, cu, n, lexicon ? { description: `My car has ${lexicon} since yesterday.` } : {});
    if (lexicon) expect(first.safety_flag).toBe(true);
    await requested(p, cu, n);
    await requested(p, cu, n);
    const fourth = await cu.c.post('/v1/me/appointments', requestBody(p, cu, n));
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('RATE_LIMITED');
  });
});

describe('calendar and availability', () => {
  it('rules, time off and the calendar; public slots respect them', async () => {
    const p = await publishedProvider(app, n, { name: `Cal Garage ${newId().slice(-6)}` });
    const day = localDay(5);
    const r = await rule(p, day.dayOfWeek, { start_time: '09:00', end_time: '12:00' });
    expect(r).toMatchObject({ day_of_week: day.dayOfWeek, start_time: '09:00', end_time: '12:00', status: 'active' });
    // Concurrency above 1 needs the capacity tools entitlement (provider default plan: not included).
    const multi = await p.c.post(`/v1/orgs/${p.id}/provider/availability-rules`, {
      location_id: p.locationId,
      day_of_week: day.dayOfWeek,
      start_time: '13:00',
      end_time: '15:00',
      slot_duration_minutes: 60,
      max_concurrent_appointments: 3,
    });
    expect([201, 403]).toContain(multi.status);
    if (multi.status === 403)
      expect(multi.body).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement_key: 'appointment_capacity_tools_enabled' });
    else await p.c.del(`/v1/orgs/${p.id}/provider/availability-rules/${multi.body.id}`);
    const anon = await app.fixtures.anonymousToken();
    const slots = async () =>
      (
        (
          await app.request<Json>({
            path: `/v1/public/orgs/${p.id}/availability?location_id=${p.locationId}&from=${day.date}&days=1`,
            token: anon,
          })
        ).body.slots as Json[]
      ).map((s) => s.start_at);
    expect(await slots()).toEqual([iso(day.at('09:00')), iso(day.at('10:00')), iso(day.at('11:00'))]);

    const cu = await customer(app, n);
    const a = await requested(p, cu, n);
    expect(
      (await p.c.post(provider(p, `/${a.id}/transitions`), { to: 'confirmed', confirmed_start_at: iso(day.at('09:00')) })).status,
    ).toBe(200);
    const off = await p.c.post(`/v1/orgs/${p.id}/provider/time-off`, {
      start_at: iso(day.at('08:30')),
      end_at: iso(day.at('10:30')),
      reason: 'Training',
    });
    expect(off.status).toBe(201);
    expect(off.body.conflicting_appointment_ids).toEqual([a.id]);
    expect(await slots()).toEqual([iso(day.at('11:00'))]);
    const cal = await p.c.get(`/v1/orgs/${p.id}/provider/calendar?from=${day.date}&to=${day.date}`);
    expect(cal.status).toBe(200);
    expect(cal.body.appointments.map((x: Json) => x.id)).toEqual([a.id]);
    expect(cal.body.time_off).toHaveLength(1);
    expect(cal.body.capacity.find((c: Json) => c.start_at === iso(day.at('09:00')))).toMatchObject({ used: 1, max: 1 });
    expect((await p.c.del(`/v1/orgs/${p.id}/provider/time-off/${off.body.time_off.id}`)).status).toBe(200);
    expect(await slots()).toEqual([iso(day.at('10:00')), iso(day.at('11:00'))]);
    expect((await p.c.get(`/v1/orgs/${p.id}/provider/calendar?from=${day.date}&to=2099-01-01`)).body.code).toBe('VALIDATION_FAILED');
    // Rule edits need If-Match; deactivation removes the slots.
    expect((await p.c.patch(`/v1/orgs/${p.id}/provider/availability-rules/${r.id}`, { end_time: '11:00' }, r.version)).body.end_time).toBe(
      '11:00',
    );
    expect((await p.c.del(`/v1/orgs/${p.id}/provider/availability-rules/${r.id}`)).status).toBe(200);
    expect(await slots()).toEqual([]);
  });
});

describe('pre-visit report', () => {
  it('history is shown to the provider only while the service_history_sharing consent is active', async () => {
    const p = await publishedProvider(app, n, { name: `History Garage ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const rec = await cu.c.post(`/v1/me/vehicles/${cu.vehicleId}/service-records`, {
      service_date: '2026-05-01',
      service_system_node_id: n.system,
      description: 'Pads replaced',
      source_type: 'user_manual',
      visibility: 'private',
    });
    expect(rec.status).toBe(201);
    const a = await requested(p, cu, n, { share_history: { policy_version: '2026-10' } });
    const report = await p.c.get(provider(p, `/${a.id}/pre-visit-report`));
    expect(report.status).toBe(200);
    expect(report.headers['cache-control']).toBe('no-store');
    expect(report.body).toMatchObject({
      appointment_id: a.id,
      status: 'shared',
      triage_status: 'not_provided',
      ai_summary_status: 'not_required',
    });
    expect(report.body.relevant_history_summary).toContain('1 service record');
    expect(report.body.previous_related_repairs).toEqual([
      expect.objectContaining({ service_date: '2026-05-01', description: 'Pads replaced' }),
    ]);
    expect(report.body.vehicle_summary).toContain('2018');
    // Withdrawing the consent hides the history at once (SEC-AZ-8: checked on every read).
    const consents = await cu.c.get('/v1/me/consents');
    const history = (consents.body.items as Json[]).find(
      (x) => x.consent_type === 'service_history_sharing' && x.scope_entity_id === a.id,
    )!;
    expect((await cu.c.post(`/v1/me/consents/${history.id}/withdraw`)).status).toBe(200);
    const after = await p.c.get(provider(p, `/${a.id}/pre-visit-report`));
    expect(after.body).toMatchObject({ relevant_history_summary: null, previous_related_repairs: null });
    // Without share_history nothing is shared.
    const plain = await requested(p, await customer(app, n), n);
    expect((await p.c.get(provider(p, `/${plain.id}/pre-visit-report`))).body.relevant_history_summary).toBeNull();
  });
});

describe('record-level BOLA', () => {
  it('another requester and another provider get 404 for every appointment record', async () => {
    const p = await publishedProvider(app, n, { name: `Bola Garage ${newId().slice(-6)}` });
    const other = await publishedProvider(app, n, { name: `Other Garage ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const stranger = await customer(app, n);
    const a = await requested(p, cu, n);
    const me = `/v1/me/appointments/${a.id}`;
    for (const res of [
      await stranger.c.get(me),
      await stranger.c.get(`${me}/history`),
      await stranger.c.get(`${me}/notes`),
      await stranger.c.get(`${me}/pre-visit-report`),
      await stranger.c.post(`${me}/transitions`, { to: 'cancelled', cancellation_reason: 'x' }),
      await stranger.c.post(`${me}/notes`, { body: 'hi', content_locale: 'en' }),
      await other.c.get(`/v1/orgs/${other.id}/provider/appointments/${a.id}`),
      await other.c.get(`/v1/orgs/${other.id}/provider/appointments/${a.id}/pre-visit-report`),
      await other.c.post(`/v1/orgs/${other.id}/provider/appointments/${a.id}/transitions`, { to: 'provider_reviewing' }),
      await other.c.get(`/v1/orgs/${other.id}/provider/appointments/${a.id}/participants`),
    ])
      expect(res.status).toBe(404);
    expect((await stranger.c.get('/v1/me/appointments')).body.items.map((x: Json) => x.id)).not.toContain(a.id);
    expect((await other.c.get(`/v1/orgs/${other.id}/provider/appointments`)).body.items.map((x: Json) => x.id)).not.toContain(a.id);
    // Participants: only active provider members can be assigned.
    const outsider = await app.fixtures.user();
    expect((await p.c.post(provider(p, `/${a.id}/participants`), { user_id: outsider.id, participant_role: 'technician' })).body.code).toBe(
      'REFERENCE_NOT_FOUND',
    );
    const tech = await p.c.post(provider(p, `/${a.id}/participants`), { user_id: p.userId, participant_role: 'technician' });
    expect(tech.status).toBe(201);
    expect((await p.c.get(provider(p, `/${a.id}/participants`))).body.items.map((x: Json) => x.participant_role)).toEqual([
      'requester',
      'technician',
    ]);
    expect((await p.c.del(provider(p, `/${a.id}/participants/${tech.body.id}`))).status).toBe(200);
  });
});
