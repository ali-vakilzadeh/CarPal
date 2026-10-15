// S4 media (40 §17, SEC-UP): two-phase upload through the signed local
// storage URL, W6 processing (sniffing, EICAR, EXIF strip + re-encode,
// encryption at rest), MEDIA_NOT_READY before the scan, attachments with the
// owning module's rules, signed downloads, deletion and redaction jobs.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { EICAR_TEXT, jpegWithExif, tinyMp4, tinyPdf } from '#libs/testing/index.js';
import { DataExportFiles } from '#modules/identity/interface/identity.js';
import { MediaHarness, idem, type Json } from './s4-support.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
let media: MediaHarness;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  media = await MediaHarness.start(app);
});
afterAll(async () => {
  await media.close();
  await app.close();
});

async function userWithToken() {
  const user = await app.fixtures.user();
  return { user, token: await app.fixtures.token(user) };
}

describe('upload → complete → scan → attach (S4 acceptance)', () => {
  it('stores a re-encoded, EXIF-free image and serves it only after the clean scan', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const bytes = await jpegWithExif();
    const ticket = await media.init(token, {
      owner: { type: 'organization', id: org.id },
      purpose: 'portfolio',
      mime: 'image/jpeg',
      bytes,
    });
    expect(ticket.status).toBe(201);
    expect(ticket.headers.location).toBe(`/v1/media/${ticket.body.upload_id}`);
    expect(ticket.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) } });
    expect(new Date(ticket.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(600_000);

    // The signature fixes type, length and checksum (SEC-UP-1).
    expect(await media.put(ticket.body, bytes, { 'content-type': 'image/png' })).toBe(403);
    expect(await media.put(ticket.body, Buffer.concat([bytes.subarray(0, -1), Buffer.from([0])]))).toBe(400);
    expect(await media.put(ticket.body, bytes)).toBe(200);

    // Before upload_complete the asset does not exist for reads; after it, it is pending the scan.
    expect((await app.request({ path: `/v1/media/${ticket.body.upload_id}`, token })).status).toBe(404);
    const done = await media.complete(token, ticket.body.upload_id);
    expect(done.status).toBe(202);
    expect(done.body).toMatchObject({
      status: 'active',
      scan_status: 'pending',
      exif_stripped: false,
      thumbnail_url: null,
      owner_type: 'organization',
    });

    // An unscanned asset is not ready: no download, no attachment (MEDIA_NOT_READY).
    const early = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${ticket.body.upload_id}/download-url`,
      token,
      body: { variant: 'display' },
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('MEDIA_NOT_READY');

    await media.drain();
    const asset = (await app.request<Json>({ path: `/v1/media/${ticket.body.upload_id}`, token })).body;
    expect(asset).toMatchObject({ scan_status: 'clean', exif_stripped: true, width: 640, height: 480, privacy_level: 'public' });
    expect(asset.thumbnail_url).toMatch(/\/o\/media\/.+\/thumb\?/);

    const dl = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${asset.id}/download-url`,
      token,
      body: { variant: 'original' },
    });
    expect(dl.status).toBe(200);
    const file = await fetch(media.local(dl.body.url));
    expect(file.status).toBe(200);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toBe('sandbox');
    const served = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(served).metadata();
    expect(meta.exif).toBeUndefined();
    expect(served.includes(Buffer.from('Secret Owner'))).toBe(false);
    // Public media: 1 h URLs (SEC-UP-4).
    expect(new Date(dl.body.expires_at).getTime() - Date.now()).toBeGreaterThan(3_000_000);

    // media.scan.completed is in the outbox for the owning modules.
    const events = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('core.domain_event_outbox').select(['event_type', 'payload']).where('aggregate_id', '=', asset.id).execute(),
    );
    expect(events).toEqual([
      expect.objectContaining({ event_type: 'media.scan.completed', payload: expect.objectContaining({ scan_status: 'clean' }) }),
    ]);

    // Attach it to a portfolio item of the organization (owning module decides who may).
    const item = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/provider/portfolio`,
      token,
      headers: idem(),
      body: { title: 'Brake job', content_locale: 'en', service_system_node_id: await anySystem(), visibility: 'public' },
    });
    expect(item.status).toBe(201);
    const attach = await app.request<Json>({
      method: 'POST',
      path: '/v1/media/attachments',
      token,
      headers: idem(),
      body: {
        media_asset_id: asset.id,
        attached_to: { type: 'portfolio_item', id: item.body.id },
        role: 'before',
        pair_group_key: 'p1',
        display_order: 0,
      },
    });
    expect(attach.status).toBe(201);
    expect(attach.body).toMatchObject({ media_asset_id: asset.id, role: 'before', pair_group_key: 'p1', media_type: 'image' });
    expect(attach.body.url).toMatch(/\/o\/media\/.+\/display\?/);
    const listed = await app.request<Json>({ path: `/v1/orgs/${org.id}/provider/portfolio`, token });
    expect(listed.body.items[0].media.map((m: Json) => m.attachment_id)).toEqual([attach.body.attachment_id]);
  });

  it('requires a pair key for before/after and refuses targets of other owners (422 REFERENCE_NOT_FOUND)', async () => {
    const a = await app.fixtures.memberOf('provider', 'provider_owner');
    const b = await app.fixtures.memberOf('provider', 'provider_owner');
    const asset = await media.upload(a.token, {
      owner: { type: 'organization', id: a.org.id },
      purpose: 'portfolio',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(32, 32),
    });
    const foreignItem = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${b.org.id}/provider/portfolio`,
      token: b.token,
      headers: idem(),
      body: { title: 'Not yours', content_locale: 'en', service_system_node_id: await anySystem(), visibility: 'public' },
    });
    const attach = (body: Json) =>
      app.request<Json>({ method: 'POST', path: '/v1/media/attachments', token: a.token, headers: idem(), body });
    expect(
      (
        await attach({
          media_asset_id: asset.id,
          attached_to: { type: 'portfolio_item', id: foreignItem.body.id },
          role: 'after',
          display_order: 0,
        })
      ).body.errors,
    ).toEqual([{ pointer: '/pair_group_key', code: 'conditional_required' }]);
    const r = await attach({
      media_asset_id: asset.id,
      attached_to: { type: 'portfolio_item', id: foreignItem.body.id },
      role: 'gallery',
      display_order: 0,
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'REFERENCE_NOT_FOUND', errors: [{ pointer: '/attached_to', code: 'reference_not_found' }] });
    // Types without a registered owning module fail closed.
    expect(
      (await attach({ media_asset_id: asset.id, attached_to: { type: 'vehicle', id: uuidv7() }, role: 'gallery', display_order: 0 }))
        .status,
    ).toBe(422);
    // B cannot touch A's asset at all.
    expect((await app.request({ path: `/v1/media/${asset.id}`, token: b.token })).status).toBe(404);
    expect((await app.request({ method: 'DELETE', path: `/v1/media/${asset.id}`, token: b.token })).status).toBe(404);
  });
});

describe('W6 processing rules', () => {
  it('quarantines a file whose bytes are not the declared type, and EICAR as infected', async () => {
    const { user, token } = await userWithToken();
    const owner = { type: 'user' as const, id: user.id };
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    const mismatch = await media.upload(token, { owner, purpose: 'avatar', mime: 'image/jpeg', bytes: png });
    expect(mismatch).toMatchObject({ status: 'quarantined', scan_status: 'failed', thumbnail_url: null });
    const infected = await media.upload(token, {
      owner,
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: Buffer.from(`%PDF-1.4\n${EICAR_TEXT}\n`),
    });
    expect(infected).toMatchObject({ status: 'quarantined', scan_status: 'infected' });
    const dl = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${infected.id}/download-url`,
      token,
      body: { variant: 'original' },
    });
    expect(dl.body.code).toBe('MEDIA_NOT_READY');
  });

  it('encrypts private documents at rest and serves them as short-lived attachments', async () => {
    const { user, token } = await userWithToken();
    const pdf = tinyPdf();
    const doc = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: pdf,
    });
    expect(doc).toMatchObject({ scan_status: 'clean', media_type: 'document', privacy_level: 'private' });
    const dl = await app.request<Json>({ method: 'POST', path: `/v1/media/${doc.id}/download-url`, token, body: { variant: 'original' } });
    expect(new Date(dl.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const res = await fetch(media.local(dl.body.url));
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);
    // On disk the object is ciphertext (lite SSE).
    const storageDir = (app.infra.storage as unknown as { root: string }).root;
    const onDisk = readFileSync(`${storageDir}/media/${doc.id}/original`);
    expect(onDisk.includes(Buffer.from('/Catalog'))).toBe(false);
    // Another user gets 404; thumbnails of documents do not exist.
    const other = (await userWithToken()).token;
    expect(
      (await app.request({ method: 'POST', path: `/v1/media/${doc.id}/download-url`, token: other, body: { variant: 'display' } })).status,
    ).toBe(404);
    expect(
      (await app.request<Json>({ method: 'POST', path: `/v1/media/${doc.id}/download-url`, token, body: { variant: 'thumbnail' } })).body
        .code,
    ).toBe('MEDIA_NOT_READY');
  });

  it('accepts MP4 up to 15 s and refuses longer videos (GD-32)', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_staff');
    const owner = { type: 'organization' as const, id: org.id };
    expect(await media.upload(token, { owner, purpose: 'portfolio', mime: 'video/mp4', bytes: tinyMp4(12) })).toMatchObject({
      scan_status: 'clean',
      duration_seconds: 12,
      exif_stripped: false,
    });
    expect(await media.upload(token, { owner, purpose: 'portfolio', mime: 'video/mp4', bytes: tinyMp4(20) })).toMatchObject({
      scan_status: 'failed',
    });
  });
});

describe('upload_init and upload_complete rules', () => {
  it('refuses types not allowed for the purpose, oversize files and other owners', async () => {
    const { user, token } = await userWithToken();
    const init = (body: Json) => app.request<Json>({ method: 'POST', path: '/v1/media/uploads', token, headers: idem(), body });
    const base = {
      purpose: 'org_logo',
      owner: { type: 'user', id: user.id },
      mime_type: 'application/pdf',
      file_size_bytes: 10,
      checksum_sha256: 'A'.repeat(43) + '=',
    };
    expect((await init(base)).body.errors).toEqual([{ pointer: '/mime_type', code: 'enum' }]);
    // GD-32: HEIC is converted to JPEG by the client; the server refuses it when the upload is requested.
    expect((await init({ ...base, purpose: 'vehicle_photo', mime_type: 'image/heic' })).body.errors).toEqual([
      { pointer: '/mime_type', code: 'enum' },
    ]);
    expect((await init({ ...base, mime_type: 'image/png', file_size_bytes: 21 * 1024 * 1024 })).body.errors).toEqual([
      { pointer: '/file_size_bytes', code: 'out_of_range', limit: String(20 * 1024 * 1024) },
    ]);
    expect((await init({ ...base, mime_type: 'image/png', owner: { type: 'user', id: uuidv7() } })).body.code).toBe('REFERENCE_NOT_FOUND');
    // An organization the caller is not a member of: 404 (SEC-AZ-2).
    const foreign = await app.fixtures.org('provider');
    expect((await init({ ...base, mime_type: 'image/png', owner: { type: 'organization', id: foreign.id } })).status).toBe(404);
  });

  it('answers UPLOAD_MISMATCH when nothing was uploaded, and LINK_EXPIRED for an expired ticket', async () => {
    const { user, token } = await userWithToken();
    const bytes = await jpegWithExif(16, 16);
    const t = await media.init(token, { owner: { type: 'user', id: user.id }, purpose: 'avatar', mime: 'image/jpeg', bytes });
    const r = await media.complete(token, t.body.upload_id);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('UPLOAD_MISMATCH');
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('media.media_assets')
        .set({ upload_expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', t.body.upload_id)
        .execute(),
    );
    expect((await media.complete(token, t.body.upload_id)).body.code).toBe('LINK_EXPIRED');
  });
});

describe('attachments, deletion and redaction', () => {
  it('updates, detaches and deletes; a deleted asset is gone with its attachments (audited)', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const asset = await media.upload(token, {
      owner: { type: 'organization', id: org.id },
      purpose: 'org_logo',
      mime: 'image/png',
      bytes: await sharp({ create: { width: 64, height: 64, channels: 4, background: '#0a0' } })
        .png()
        .toBuffer(),
    });
    const logo = await app.request<Json>({
      method: 'POST',
      path: '/v1/media/attachments',
      token,
      headers: idem(),
      body: { media_asset_id: asset.id, attached_to: { type: 'organization', id: org.id }, role: 'logo', display_order: 0 },
    });
    expect(logo.status).toBe(201);
    const upd = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/media/attachments/${logo.body.attachment_id}`,
      token,
      body: { caption: 'Our logo', display_order: 2 },
    });
    expect(upd.body).toMatchObject({ caption: 'Our logo', display_order: 2 });
    // A staff member cannot attach to the organization record (M+ only) — 404.
    const staff = await app.fixtures.user();
    await app.fixtures.member(staff, org, 'provider_staff');
    const staffToken = await app.fixtures.token(staff);
    const staffAttach = await app.request<Json>({
      method: 'POST',
      path: '/v1/media/attachments',
      token: staffToken,
      headers: idem(),
      body: { media_asset_id: asset.id, attached_to: { type: 'organization', id: org.id }, role: 'cover', display_order: 0 },
    });
    expect(staffAttach.status).toBe(404);
    expect((await app.request({ method: 'DELETE', path: `/v1/media/attachments/${logo.body.attachment_id}`, token })).status).toBe(200);
    expect((await app.request({ method: 'DELETE', path: `/v1/media/attachments/${logo.body.attachment_id}`, token })).status).toBe(404);
    expect((await app.request({ method: 'DELETE', path: `/v1/media/${asset.id}`, token })).status).toBe(200);
    expect((await app.request({ path: `/v1/media/${asset.id}`, token })).status).toBe(404);
    const audit = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('analytics.audit_logs').select('action').where('entity_id', '=', asset.id).execute(),
    );
    expect(audit.map((x) => x.action)).toEqual(['media.deleted']);
  });

  it('blurs hand-drawn regions through an async redaction job', async () => {
    const { user, token } = await userWithToken();
    const asset = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_photo',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(200, 100),
    });
    const bad = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${asset.id}/redaction`,
      token,
      headers: idem(),
      body: { decision: 'apply_regions' },
    });
    expect(bad.body.errors).toEqual([{ pointer: '/regions', code: 'conditional_required' }]);
    const job = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${asset.id}/redaction`,
      token,
      headers: idem(),
      body: { decision: 'apply_regions', regions: [{ x: '0.1', y: '0.1', w: '0.3', h: '0.5' }] },
    });
    expect(job.status).toBe(202);
    expect(job.body).toMatchObject({ kind: 'redaction', status: 'queued' });
    await media.drain();
    const done = await app.request<Json>({ path: `/v1/jobs/${job.body.id}`, token });
    expect(done.body).toMatchObject({ status: 'succeeded', result: { type: 'media_asset', id: asset.id } });
    expect((await app.request<Json>({ path: `/v1/media/${asset.id}`, token })).body.redaction_status).toBe('completed');
    // AI suggestions do not exist before S9.
    const ai = await app.request<Json>({
      method: 'POST',
      path: `/v1/media/${asset.id}/redaction`,
      token,
      headers: idem(),
      body: { decision: 'apply_suggestions' },
    });
    expect(ai.body.errors).toEqual([{ pointer: '/decision', code: 'enum' }]);
  });

  it('delivers DSR export files through DataExportFiles (5-minute attachment URLs)', async () => {
    const { user, token } = await userWithToken();
    const doc = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: tinyPdf(),
    });
    const files = app.app.get(DataExportFiles, { strict: false });
    const tx = app.fixtures.worker;
    expect(await tx.run({ actorType: 'system' }, (s) => files.available(s, doc.id))).toBe(true);
    const signed = await tx.run({ actorType: 'system' }, (s) => files.signedUrl(s, doc.id));
    expect(signed?.url).toContain('d=attachment');
    expect(await tx.run({ actorType: 'system' }, (s) => files.available(s, uuidv7()))).toBe(false);
  });
});

let systemNode: string | undefined;
async function anySystem(): Promise<string> {
  systemNode ??= await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
    const n = await db
      .selectFrom('taxonomy.taxonomy_nodes')
      .select('id')
      .where('type', '=', 'service_system')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return n.id;
  });
  return systemNode;
}
