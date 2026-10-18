// Contract sweep resolvers: media uploads, attachments, downloads, redaction (40 §17).
// media.upload_put is the signed storage PUT (host storage): it is not an API
// route, so the generated suite does not list it (media.int.test.ts covers it).
import { createHash } from 'node:crypto';
import { jpegWithExif } from '#libs/testing/index.js';
import { openCase, purpose } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Resolvers } from '../harness.js';

async function initBody(as: Actor) {
  const bytes = await jpegWithExif(64, 64);
  return {
    bytes,
    body: {
      purpose: 'vehicle_photo',
      owner: { type: 'user', id: as.user.id },
      mime_type: 'image/jpeg',
      file_size_bytes: bytes.length,
      checksum_sha256: createHash('sha256').update(bytes).digest('base64'),
    },
  };
}

async function logo(h: Harness): Promise<{ as: Actor; assetId: string }> {
  const as = await h.member('provider');
  const asset = await h.upload(as, 'org_logo');
  return { as, assetId: asset.id as string };
}

async function attached(h: Harness): Promise<{ as: Actor; attachmentId: string }> {
  const { as, assetId } = await logo(h);
  const a = ok(
    await as.c.post('/v1/media/attachments', {
      media_asset_id: assetId,
      attached_to: { type: 'organization', id: as.org!.id },
      role: 'logo',
      display_order: 0,
    }),
    'attachment',
  );
  return { as, attachmentId: a.attachment_id as string };
}

export const resolvers: Resolvers = {
  'media.upload_init': async (h) => {
    const as = await h.user();
    // The owner reference must be the caller (or an organization of the caller).
    return { as, body: (await initBody(as)).body, bodyRefs: true };
  },
  'media.upload_complete': async (h) => {
    const as = await h.user();
    const { body, bytes } = await initBody(as);
    const ticket = ok(await as.c.post('/v1/media/uploads', body), 'upload_init');
    if ((await h.media.put(ticket, bytes)) !== 200) throw new Error('storage PUT failed');
    return { as, params: { upload_id: ticket.upload_id as string } };
  },
  'media.get': async (h) => {
    const as = await h.user();
    return { as, params: { media_id: (await h.upload(as, 'vehicle_photo')).id as string } };
  },
  'media.download_url': async (h) => {
    const as = await h.user();
    return { as, params: { media_id: (await h.upload(as, 'vehicle_photo')).id as string }, body: { variant: 'display' } };
  },
  'media.attach': async (h) => {
    const { as, assetId } = await logo(h);
    return {
      as,
      body: { media_asset_id: assetId, attached_to: { type: 'organization', id: as.org!.id }, role: 'logo', display_order: 0 },
      bodyRefs: true,
    };
  },
  'media.attachment_update': async (h) => {
    const { as, attachmentId } = await attached(h);
    return { as, params: { attachment_id: attachmentId }, body: { caption: 'Our logo', display_order: 2 } };
  },
  'media.detach': async (h) => {
    const { as, attachmentId } = await attached(h);
    return { as, params: { attachment_id: attachmentId } };
  },
  'media.delete': async (h) => {
    const as = await h.user();
    return { as, params: { media_id: (await h.upload(as, 'vehicle_photo')).id as string } };
  },
  'media.redaction_decide': async (h) => {
    const as = await h.user();
    return {
      as,
      params: { media_id: (await h.upload(as, 'vehicle_photo')).id as string },
      body: { decision: 'apply_regions', regions: [{ x: '0.1', y: '0.1', w: '0.3', h: '0.5' }] },
    };
  },
  'admin.media_download_url': async (h) => {
    const as = await h.member('provider');
    const doc = await h.upload(as, 'verification_document', { mime: 'application/pdf' });
    const caseId = await openCase(h.api, { type: 'organization', targetId: as.org!.id });
    return {
      as: await h.staff('platform_moderator'),
      params: { media_id: doc.id as string },
      headers: purpose('case', caseId),
      body: { variant: 'original' },
    };
  },
};
