// Platform operations (40 §22): health.get, config.client, jobs.get, jobs.cancel.
// Responses are checked against the contract by the pipeline (CARPAL_VALIDATE_RESPONSES=1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
});
afterAll(() => app.close());

describe('health.get', () => {
  it('answers without a token or client header and discloses nothing', async () => {
    const res = await app.request({ path: '/v1/health', client: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('config.client', () => {
  it('returns versions, evaluated flags and the region in the caller locale; cacheable for anonymous callers', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on a validated response
    const res = await app.request<Record<string, any>>({
      path: '/v1/config/client',
      token: await app.fixtures.anonymousToken(),
      headers: { 'accept-language': 'fa' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.vary).toBe('Accept-Language');
    expect(res.headers['content-language']).toBe('fa');
    expect(res.body).toMatchObject({ contract_version: '1.1.0', min_supported_version: '1.0.0' });
    // The taxonomy module's catalog version (S3; seeded "1.0.0" before the module existed).
    expect(res.body.taxonomy_version).toMatch(/^t[0-9a-z]+-[0-9a-z]+$/);
    expect(res.body.region).toMatchObject({ region_key: 'ir-pilot', default_locale: 'fa', currency: 'IRR', calendar_default: 'jalali' });
    expect(res.body.region.cities[0].label).toEqual({ text: 'تهران', locale: 'fa' });
    expect(res.body.flags).toContainEqual({ key: 'map.enabled', enabled: true });
    expect(res.body.flags).toContainEqual({ key: 'featured.enabled', enabled: false });
    // No targeting rules are exposed (40 §22.1).
    expect(Object.keys(res.body.flags[0]).sort()).toEqual(['enabled', 'key']);
  });

  it('is private (no-store) for signed-in users', async () => {
    const token = await app.fixtures.token(await app.fixtures.user());
    const res = await app.request({ path: '/v1/config/client', token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('jobs.get / jobs.cancel', () => {
  it('shows a job to its owner with an ETag, and to members of its organization; 404 for everyone else', async () => {
    const owner = await app.fixtures.user();
    const ownerToken = await app.fixtures.token(owner);
    const own = await app.fixtures.job(owner, { status: 'succeeded' });
    const res = await app.request<Record<string, unknown>>({ path: `/v1/jobs/${own}`, token: ownerToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: own,
      kind: 'data_export',
      status: 'succeeded',
      progress: 100,
      result: { type: 'data_subject_request' },
      version: 1,
    });
    expect(res.headers.etag).toBe('"v1"');

    const stranger = await app.fixtures.token(await app.fixtures.user());
    expect((await app.request({ path: `/v1/jobs/${own}`, token: stranger })).status).toBe(404);
    expect((await app.request({ path: `/v1/jobs/${uuidv7()}`, token: ownerToken })).status).toBe(404);

    const { org } = await app.fixtures.memberOf('vendor', 'vendor_owner');
    const staffMember = await app.fixtures.user();
    await app.fixtures.member(staffMember, org, 'vendor_staff');
    const orgJob = await app.fixtures.job(owner, { orgId: org.id });
    expect((await app.request({ path: `/v1/jobs/${orgJob}`, token: await app.fixtures.token(staffMember) })).status).toBe(200);
    expect((await app.request({ path: `/v1/jobs/${orgJob}`, token: stranger })).status).toBe(404);
  });

  it('cancels a queued job of the caller once; finished jobs are 409 INVALID_TRANSITION; others get 404', async () => {
    const owner = await app.fixtures.user();
    const token = await app.fixtures.token(owner);
    const job = await app.fixtures.job(owner, { status: 'queued' });
    const cancel = (id: string, t = token, key = uuidv7()) =>
      app.request({ method: 'POST', path: `/v1/jobs/${id}/cancel`, token: t, headers: { 'idempotency-key': key } });

    expect((await cancel(job, await app.fixtures.token(await app.fixtures.user()))).status).toBe(404);
    const res = await cancel(job);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: job, status: 'cancelled', version: 2 });
    expect(res.headers.etag).toBe('"v2"');
    const again = await cancel(job);
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('INVALID_TRANSITION');
    expect((await cancel(await app.fixtures.job(owner, { status: 'succeeded' }))).status).toBe(409);
  });
});
