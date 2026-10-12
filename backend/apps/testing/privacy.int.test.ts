// S3 consent (40 §6.4), data subject requests (§6.5) and onboarding (§6.6),
// plus the L16 consent gate (ConsentChecker, never cached).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { ConsentScopes } from '#modules/identity/interface/identity.js';
import { createTestApp, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
type Json = Record<string, any>;

let app: TestApp;
const idem = () => ({ 'idempotency-key': uuidv7() });
const fresh = () => ({ acr: 'aal2' as const, authTime: Math.floor(Date.now() / 1000) });

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  // A vehicle-like scope for tests: any id ending in "0" belongs to the caller (S5 registers the real vehicle check).
  app.app.get(ConsentScopes, { strict: false }).register('vehicle', async (_s, _user, id) => id.endsWith('0'));
});
afterAll(() => app.close());

async function grant(token: string, body: Json) {
  return app.request<Json>({ method: 'POST', path: '/v1/me/consents', token, body, headers: idem() });
}

describe('consents.grant / list / withdraw', () => {
  it('records, lists and withdraws a consent; withdrawal emits consent.withdrawn and switches the preference off', async () => {
    const user = await app.fixtures.user();
    const token = await app.fixtures.token(user);
    const g = await grant(token, { consent_type: 'ai_personalization', policy_version: '2026-10', granted_to: { type: 'platform' } });
    expect(g.status).toBe(201);
    expect(g.headers.location).toBe(`/v1/me/consents/${g.body.id}`);
    expect(g.body).toMatchObject({
      subject_type: 'user',
      subject_id: user.id,
      granted: true,
      withdrawn_at: null,
      source: 'ui',
      granted_to_type: 'platform',
    });
    const pref = await app.request<Json>({ path: '/v1/me/preferences', token });
    expect(
      (
        await app.request({
          method: 'PATCH',
          path: '/v1/me/preferences',
          token,
          body: { ai_personalization_enabled: true },
          headers: { 'if-match': pref.headers.etag! },
        })
      ).status,
    ).toBe(200);

    const active = await app.request<Json>({ path: '/v1/me/consents?active=true', token });
    expect(active.body.items.map((c: Json) => c.id)).toEqual([g.body.id]);
    const w = await app.request<Json>({ method: 'POST', path: `/v1/me/consents/${g.body.id}/withdraw`, token, headers: idem() });
    expect(w.status).toBe(200);
    expect(w.body.withdrawn_at).not.toBeNull();
    expect(
      (await app.request<Json>({ method: 'POST', path: `/v1/me/consents/${g.body.id}/withdraw`, token, headers: idem() })).status,
    ).toBe(409);
    expect((await app.request<Json>({ path: '/v1/me/consents?active=true', token })).body.items).toEqual([]);
    expect((await app.request<Json>({ path: '/v1/me/consents?active=false', token })).body.items).toHaveLength(1);
    expect((await app.request<Json>({ path: '/v1/me/preferences', token })).body.ai_personalization_enabled).toBe(false);
    const events = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('core.domain_event_outbox').select(['event_type', 'payload']).where('aggregate_id', '=', g.body.id).execute(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'consent.withdrawn',
      payload: { consent_type: 'ai_personalization', subject_id: user.id },
    });
    // Another user cannot withdraw it (404).
    const other = await app.fixtures.token(await app.fixtures.user());
    expect(
      (await app.request({ method: 'POST', path: `/v1/me/consents/${g.body.id}/withdraw`, token: other, headers: idem() })).status,
    ).toBe(404);
  });

  it('validates the grant: conditional grantee id, organization types, scope ownership, expiry', async () => {
    const token = await app.fixtures.token(await app.fixtures.user());
    expect(
      (await grant(token, { consent_type: 'vehicle_data_sharing', policy_version: '1', granted_to: { type: 'organization' } })).body.errors,
    ).toEqual([{ pointer: '/granted_to/id', code: 'conditional_required' }]);
    expect(
      (
        await grant(token, {
          consent_type: 'vehicle_data_sharing',
          policy_version: '1',
          granted_to: { type: 'organization', id: uuidv7() },
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
    expect((await grant(token, { consent_type: 'fleet_data_ai_use', policy_version: '1' })).body.errors).toEqual([
      { pointer: '/consent_type', code: 'enum' },
    ]);
    expect(
      (await grant(token, { consent_type: 'photo_publishing', policy_version: '1', scope: { type: 'media_asset', id: uuidv7() } })).body
        .code,
    ).toBe('REFERENCE_NOT_FOUND');
    const vehicleId = `${uuidv7().slice(0, -1)}0`;
    const scoped = await grant(token, {
      consent_type: 'vehicle_data_sharing',
      policy_version: '1',
      scope: { type: 'vehicle', id: vehicleId },
    });
    expect(scoped.status).toBe(201);
    expect(scoped.body).toMatchObject({ scope_entity_type: 'vehicle', scope_entity_id: vehicleId });
    expect(
      (await grant(token, { consent_type: 'marketing', policy_version: '1', expires_at: '2020-01-01T00:00:00Z' })).body.errors,
    ).toEqual([{ pointer: '/expires_at', code: 'in_past' }]);
  });
});

describe('ConsentChecker (L16)', () => {
  it('answers from the current records in any caller context: scope, grantee, withdrawal and expiry apply', async () => {
    const owner = await app.fixtures.user();
    const token = await app.fixtures.token(owner);
    const { org: provider, user: providerUser } = await app.fixtures.memberOf('provider', 'provider_staff');
    const vehicle = `${uuidv7().slice(0, -1)}0`;
    const checker = app.app.get(ConsentChecker, { strict: false });
    const tx = app.app.get(TxRunner, { strict: false });
    // Asked as the provider member (RLS would hide the owner's records): the definer function answers.
    const ask = (scopeId = vehicle, grantee = provider.id) =>
      tx.run({ actorType: 'user', userId: providerUser.id, orgId: provider.id }, (scope) =>
        checker.isGranted(scope, {
          consentType: 'vehicle_data_sharing',
          subject: { type: 'user', id: owner.id },
          scopeEntity: { type: 'vehicle', id: scopeId },
          grantee: { type: 'organization', id: grantee },
        }),
      );
    expect(await ask()).toBe(false);
    const g = await grant(token, {
      consent_type: 'vehicle_data_sharing',
      policy_version: '1',
      scope: { type: 'vehicle', id: vehicle },
      granted_to: { type: 'organization', id: provider.id },
    });
    expect(await ask()).toBe(true);
    expect(await ask(`${uuidv7().slice(0, -1)}0`)).toBe(false); // another vehicle
    expect(await ask(vehicle, (await app.fixtures.org('provider')).id)).toBe(false); // another provider
    await app.request({ method: 'POST', path: `/v1/me/consents/${g.body.id}/withdraw`, token, headers: idem() });
    expect(await ask()).toBe(false); // withdrawal applies on the next read
  });
});

describe('consent requests (cn links)', () => {
  async function consentRequest(subject: TestUser, org: { id: string }, o: { expired?: boolean } = {}) {
    const links = app.app.get(LinkTokens, { strict: false });
    const link = links.issue('cn');
    const id = uuidv7();
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('identity.consent_requests')
        .values({
          id,
          requested_by_organization_id: org.id,
          requested_by_user_id: subject.id,
          subject_user_id: subject.id,
          consent_type: 'showcase_publishing',
          scope_entity_type: 'portfolio_item',
          scope_entity_id: uuidv7(),
          source_visit_type: 'appointment',
          source_visit_id: uuidv7(),
          purpose_i18n_key: 'consent.showcase.purpose',
          token_hash: link.hash,
          expires_at: o.expired ? new Date(Date.now() - 1000) : link.expiresAt!,
        })
        .execute(),
    );
    return { id, token: link.token };
  }

  it('shows the request to its subject only, then grants once (LINK_USED after)', async () => {
    const subject = await app.fixtures.user();
    const org = await app.fixtures.org('provider');
    const req = await consentRequest(subject, org);
    const token = await app.fixtures.token(subject);
    const view = await app.request<Json>({ method: 'POST', path: '/v1/consent-requests/view', token, body: { token: req.token } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      consent_type: 'showcase_publishing',
      requested_by: { id: org.id },
      scope: { type: 'portfolio_item' },
      preview_media_urls: [],
    });
    const stranger = await app.fixtures.token(await app.fixtures.user());
    const mismatch = await app.request<Json>({
      method: 'POST',
      path: '/v1/consent-requests/view',
      token: stranger,
      body: { token: req.token },
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('LINK_RECIPIENT_MISMATCH');
    const respond = (t: string) =>
      app.request<Json>({
        method: 'POST',
        path: '/v1/consent-requests/respond',
        token: t,
        body: { token: req.token, decision: 'grant', policy_version: '2026-10' },
        headers: idem(),
      });
    const ok = await respond(token);
    expect(ok.status).toBe(200);
    expect(ok.body.consent).toMatchObject({ consent_type: 'showcase_publishing', granted_to_type: 'organization', granted_to_id: org.id });
    const used = await respond(token);
    expect(used.status).toBe(410);
    expect(used.body.code).toBe('LINK_USED');
  });

  it('declines without a record; expired and unknown links are LINK_EXPIRED', async () => {
    const subject = await app.fixtures.user();
    const org = await app.fixtures.org('vendor');
    const token = await app.fixtures.token(subject);
    const req = await consentRequest(subject, org);
    const declined = await app.request<Json>({
      method: 'POST',
      path: '/v1/consent-requests/respond',
      token,
      body: { token: req.token, decision: 'decline', policy_version: '1' },
      headers: idem(),
    });
    expect(declined.body).toEqual({ consent: null });
    const expired = await consentRequest(subject, org, { expired: true });
    const e = await app.request<Json>({ method: 'POST', path: '/v1/consent-requests/view', token, body: { token: expired.token } });
    expect(e.body.code).toBe('LINK_EXPIRED');
    const unknown = await app.request<Json>({
      method: 'POST',
      path: '/v1/consent-requests/view',
      token,
      body: { token: `cp_cn_${'a'.repeat(43)}` },
    });
    expect(unknown.body.code).toBe('LINK_EXPIRED');
  });
});

describe('organization consents', () => {
  it('owners (aal2) grant and withdraw organization consents; any member lists; staff roles cannot grant', async () => {
    const { org, user: owner } = await app.fixtures.memberOf('fleet', 'fleet_owner');
    const ownerToken = await app.fixtures.token(owner, fresh());
    const res = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/consents`,
      token: ownerToken,
      body: { consent_type: 'fleet_data_ai_use', policy_version: '1' },
      headers: idem(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subject_type: 'organization', subject_id: org.id });
    const wrongType = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/consents`,
      token: ownerToken,
      body: { consent_type: 'marketing', policy_version: '1' },
      headers: idem(),
    });
    expect(wrongType.status).toBe(422);
    const viewer = await app.fixtures.user();
    await app.fixtures.member(viewer, org, 'fleet_viewer');
    const viewerToken = await app.fixtures.token(viewer, fresh());
    expect((await app.request<Json>({ path: `/v1/orgs/${org.id}/consents`, token: viewerToken })).body.items).toHaveLength(1);
    expect(
      (
        await app.request({
          method: 'POST',
          path: `/v1/orgs/${org.id}/consents`,
          token: viewerToken,
          body: { consent_type: 'fleet_data_ai_use', policy_version: '1' },
          headers: idem(),
        })
      ).status,
    ).toBe(404);
    const w = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/consents/${res.body.id}/withdraw`,
      token: ownerToken,
      headers: idem(),
    });
    expect(w.status).toBe(200);
    expect(w.body.withdrawn_at).not.toBeNull();
  });
});

describe('data subject requests', () => {
  it('files one open request per type (AAL2); lists and reads only the caller’s; download needs a completed export', async () => {
    const user = await app.fixtures.user();
    const token = await app.fixtures.token(user, fresh());
    const create = (body: Json) => app.request<Json>({ method: 'POST', path: '/v1/me/data-requests', token, body, headers: idem() });
    const r = await create({ request_type: 'export', details: 'everything please' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ request_type: 'export', status: 'received', export_available: false, completed_at: null });
    expect(new Date(r.body.due_at).getTime() - new Date(r.body.requested_at).getTime()).toBe(30 * 86_400_000);
    const dup = await create({ request_type: 'export' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
    expect((await create({ request_type: 'deletion' })).status).toBe(201);
    const list = await app.request<Json>({ path: '/v1/me/data-requests', token });
    expect(list.body.items.map((d: Json) => d.request_type)).toEqual(['deletion', 'export']);
    expect((await app.request<Json>({ path: `/v1/me/data-requests/${r.body.id}`, token })).body.id).toBe(r.body.id);
    const other = await app.fixtures.token(await app.fixtures.user(), fresh());
    expect((await app.request({ path: `/v1/me/data-requests/${r.body.id}`, token: other })).status).toBe(404);
    const dl = await app.request<Json>({ method: 'POST', path: `/v1/me/data-requests/${r.body.id}/download`, token });
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('INVALID_TRANSITION');
    // A completed export whose file is gone (no media module yet): 410.
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('identity.data_subject_requests')
        .set({ status: 'completed', completed_at: new Date(), export_media_asset_id: uuidv7() })
        .where('id', '=', r.body.id)
        .execute(),
    );
    const gone = await app.request<Json>({ method: 'POST', path: `/v1/me/data-requests/${r.body.id}/download`, token });
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('LINK_EXPIRED');
  });
});

describe('onboarding', () => {
  it('starts a flow with If-Match "v1", saves steps, completes; assisted flows need the owner’s terms first', async () => {
    const user = await app.fixtures.user();
    const token = await app.fixtures.token(user, fresh());
    const put = (flow: string, body: Json, ifMatch: string) =>
      app.request<Json>({ method: 'PUT', path: `/v1/me/onboarding/${flow}`, token, body, headers: { 'if-match': ifMatch } });
    expect((await app.request<Json>({ path: '/v1/me/onboarding', token })).body.items).toEqual([]);
    expect((await put('individual', { current_step: 'add_vehicle' }, '"v2"')).status).toBe(412);
    const s1 = await put('individual', { current_step: 'add_vehicle', completed_step: 'profile' }, '"v1"');
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({
      flow_type: 'individual',
      current_step: 'add_vehicle',
      completed_steps: ['profile'],
      status: 'in_progress',
      version: 1,
    });
    const s2 = await put('individual', { current_step: 'done', completed_step: 'add_vehicle', status: 'completed' }, s1.headers.etag!);
    expect(s2.body).toMatchObject({ status: 'completed', completed_steps: ['profile', 'add_vehicle'], version: 2 });
    expect(s2.body.completed_at).not.toBeNull();
    expect((await put('individual', { current_step: 'x', status: 'in_progress' }, s2.headers.etag!)).status).toBe(409);

    // Assisted provider onboarding created by staff (S8): completion waits for the owner's terms acceptance.
    const staff = await app.fixtures.staff('platform_support');
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('identity.onboarding_progress')
        .values({ user_id: user.id, flow_type: 'provider', current_step: 'services', assisted: true, assisted_by_user_id: staff.id })
        .execute(),
    );
    const list = await app.request<Json>({ path: '/v1/me/onboarding', token });
    const assisted = list.body.items.find((o: Json) => o.flow_type === 'provider');
    expect(assisted).toMatchObject({ assisted: true, assisted_by_display_name: 'Test' });
    const early = await put('provider', { current_step: 'done', status: 'completed' }, `"v${assisted.version}"`);
    expect(early.status).toBe(409);
    const accept = await app.request<Json>({
      method: 'POST',
      path: '/v1/me/onboarding/provider/accept-terms',
      token,
      body: { terms_version: 'b2b-1.0' },
      headers: idem(),
    });
    expect(accept.status).toBe(200);
    const done = await put('provider', { current_step: 'done', status: 'completed' }, accept.headers.etag!);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
  });
});
