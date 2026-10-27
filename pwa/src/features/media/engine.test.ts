// P7.T7: the upload state machine with a mocked fetch — the real typed client over a fake transport, so the
// requests (media.upload_init body, Idempotency-Key, the signed PUT, upload_complete, polling media.get with 404 as
// "not ready" and CarPal-Poll-After-Ms) are what the browser would send. Browser decoding/hashing is stubbed.
import type { MediaAsset, UploadTicket } from '@carpal/api-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type TransportRequest } from '@/lib/api/client';
import { POLL, runUpload, scanOutcome, type UploadDeps, type UploadState } from './engine';
import { acceptFor, checkFile, isHeic, mimeOf } from './policy';

const MEDIA_ID = '0195f3b1-6a2b-7c3d-8e4f-00000000ad01';
const UPLOAD_ID = '0195f3b1-6a2b-7c3d-8e4f-00000000ad02';
const OWNER = '0195f3b1-6a2b-7c3d-8e4f-00000000ad03';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function asset(o: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: MEDIA_ID,
    created_at: '2026-10-26T10:00:00Z',
    updated_at: '2026-10-26T10:00:00Z',
    version: 1,
    owner_type: 'user',
    owner_id: OWNER,
    purpose: 'service_evidence',
    media_type: 'document',
    mime_type: 'application/pdf',
    file_size_bytes: 9,
    width: null,
    height: null,
    duration_seconds: null,
    privacy_level: 'private',
    scan_status: 'pending',
    exif_stripped: false,
    redaction_status: 'not_needed',
    redaction_insight_id: null,
    consent_status: 'not_required',
    moderation_status: 'not_required',
    status: 'active',
    thumbnail_url: null,
    ...o,
  } as MediaAsset;
}

const ticket: UploadTicket = {
  upload_id: UPLOAD_ID,
  method: 'PUT',
  url: 'http://127.0.0.1:8083/o/uploads/x?exp=1&sig=s',
  headers: { 'Content-Type': 'application/pdf', 'Content-Length': '9', 'x-amz-checksum-sha256': 'c2hh' },
  expires_at: '2026-10-26T10:10:00Z',
};

/** A fake API host: answers by route, records requests. `gets` is the sequence of media.get answers. */
function setup(o: { gets?: (() => Response)[]; init?: () => Response; complete?: () => Response; put?: number } = {}) {
  const requests: TransportRequest[] = [];
  const gets = [...(o.gets ?? [() => json(200, asset({ scan_status: 'clean', thumbnail_url: null }))])];
  const transport = vi.fn(async (req: TransportRequest) => {
    requests.push(req);
    if (req.method === 'POST' && req.path === '/v1/media/uploads') return o.init?.() ?? json(201, ticket);
    if (req.method === 'POST' && req.path === `/v1/media/uploads/${UPLOAD_ID}/complete`) return o.complete?.() ?? json(202, asset());
    if (req.method === 'GET' && req.path === `/v1/media/${MEDIA_ID}`) return (gets.length > 1 ? gets.shift()! : gets[0]!)();
    return json(404, { code: 'NOT_FOUND' });
  });
  const api = createApiClient({ transport, sleep: async () => {}, random: () => 0 });
  const sleeps: number[] = [];
  let clock = 0;
  const put = vi.fn(async (_t: UploadTicket, _f: File, onProgress: (n: number) => void) => {
    onProgress(0.5);
    onProgress(1);
    return o.put ?? 200;
  });
  const deps: UploadDeps = {
    api,
    inspect: vi.fn(async () => ({ pixels: 12_000_000 })),
    convertHeic: vi.fn(async (f: File) => new File([await f.arrayBuffer()], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' })),
    sha256: vi.fn(async () => 'c2hh'),
    put,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, requests, put, sleeps };
}

const pdf = () => new File(['%PDF-1.7 x'], 'invoice.pdf', { type: 'application/pdf' });
const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' });

async function run(file: File, s: ReturnType<typeof setup>, purpose: Parameters<typeof runUpload>[0]['purpose'] = 'service_evidence') {
  const states: UploadState[] = [];
  const final = await runUpload({ file, purpose, ownerId: OWNER }, s.deps, (st) => states.push(st));
  return { final, phases: [...new Set(states.map((st) => st.phase))], states };
}

describe('upload state machine (P7.T2, SEC-UP-1..3)', () => {
  it('checks, hashes, asks for a ticket, PUTs with progress, completes and waits for a clean scan', async () => {
    const s = setup({
      gets: [() => json(404, { code: 'NOT_FOUND' }), () => json(200, asset()), () => json(200, asset({ scan_status: 'clean' }))],
    });
    const { final, phases, states } = await run(pdf(), s);
    expect(final.phase).toBe('ready');
    expect(final.asset?.scan_status).toBe('clean');
    expect(phases).toEqual(['checking', 'hashing', 'sending', 'processing', 'ready']);
    expect(states.some((st) => st.phase === 'sending' && st.progress === 0.5)).toBe(true);

    const init = s.requests.find((r) => r.path === '/v1/media/uploads')!;
    expect(JSON.parse(init.body!)).toEqual({
      purpose: 'service_evidence',
      owner: { type: 'user', id: OWNER },
      mime_type: 'application/pdf',
      file_size_bytes: 10,
      checksum_sha256: 'c2hh',
    });
    expect(init.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.put).toHaveBeenCalledWith(ticket, expect.any(File), expect.any(Function), undefined);
    // 404 right after completion is "not ready", polled again (BA-06).
    expect(s.requests.filter((r) => r.path === `/v1/media/${MEDIA_ID}`)).toHaveLength(3);
    expect(s.sleeps[0]).toBe(POLL.firstMs);
  });

  it('honours CarPal-Poll-After-Ms between scan polls', async () => {
    const s = setup({
      gets: [() => json(200, asset(), { 'carpal-poll-after-ms': '2500' }), () => json(200, asset({ scan_status: 'clean' }))],
    });
    await run(pdf(), s);
    expect(s.sleeps).toEqual([POLL.firstMs, 2500]);
  });

  it('converts HEIC photos to JPEG before anything is sent (GD-32)', async () => {
    const s = setup({ gets: [() => json(200, asset({ media_type: 'image', mime_type: 'image/jpeg', scan_status: 'clean' }))] });
    const heic = new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: '' });
    const { final, phases } = await run(heic, s);
    expect(phases).toContain('converting');
    expect(final.converted).toBe(true);
    expect(final.file.name).toBe('IMG_0001.jpg');
    expect(JSON.parse(s.requests[0]!.body!).mime_type).toBe('image/jpeg');
  });

  it('asks for a JPEG when the browser cannot convert HEIC', async () => {
    const s = setup();
    s.deps.convertHeic = async () => {
      throw new Error('no decoder');
    };
    const { final } = await run(new File(['x'], 'a.heic', { type: 'image/heic' }), s);
    expect(final).toMatchObject({ phase: 'failed', failure: 'heic' });
    expect(s.requests).toHaveLength(0);
  });

  it('refuses before sending: wrong type for the purpose, size, megapixels, video length, fake PDF', async () => {
    const s = setup();
    expect((await run(new File(['x'], 'a.mp4', { type: 'video/mp4' }), s, 'service_evidence')).final.failure).toBe('type');
    expect((await run(new File(['x'], 'notes.txt', { type: 'text/plain' }), s)).final.failure).toBe('type');
    const big = new File([new Uint8Array(1)], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    expect((await run(big, s)).final.failure).toBe('size');
    s.deps.inspect = async () => ({ pixels: 48_000_000 });
    expect((await run(jpeg(), s)).final.failure).toBe('pixels');
    s.deps.inspect = async () => ({ seconds: 16.2 });
    expect((await run(new File(['x'], 'clip.mp4', { type: 'video/mp4' }), s, 'issue_photo')).final.failure).toBe('duration');
    s.deps.inspect = async () => ({ unreadable: true });
    expect((await run(jpeg(), s)).final.failure).toBe('unreadable');
    expect((await run(new File(['<html>'], 'x.pdf', { type: 'application/pdf' }), s)).final.failure).toBe('type');
    expect(s.requests).toHaveLength(0);
  });

  it('maps server and storage failures to reasons', async () => {
    expect((await run(pdf(), setup({ init: () => json(422, { code: 'VALIDATION_FAILED' }) }))).final.failure).toBe('refused');
    expect((await run(pdf(), setup({ put: 403 }))).final.failure).toBe('expired');
    expect((await run(pdf(), setup({ complete: () => json(422, { code: 'UPLOAD_MISMATCH' }) }))).final.failure).toBe('mismatch');
    expect((await run(pdf(), setup({ complete: () => json(410, { code: 'LINK_EXPIRED' }) }))).final.failure).toBe('expired');
    expect((await run(pdf(), setup({ gets: [() => json(200, asset({ scan_status: 'infected' }))] }))).final.failure).toBe('infected');
    expect((await run(pdf(), setup({ gets: [() => json(200, asset({ status: 'quarantined' }))] }))).final.failure).toBe('quarantined');
    expect((await run(pdf(), setup({ gets: [() => json(200, asset({ scan_status: 'failed' }))] }))).final.failure).toBe('scanFailed');
  });

  it('gives up after two minutes of scanning with "timeout" (the user can check again)', async () => {
    const { final } = await run(pdf(), setup({ gets: [() => json(200, asset())] }));
    expect(final).toMatchObject({ phase: 'failed', failure: 'timeout' });
  });

  it('reads scan outcomes', () => {
    expect(scanOutcome(asset())).toBe('pending');
    expect(scanOutcome(asset({ scan_status: 'clean' }))).toBe('ready');
    expect(scanOutcome(asset({ scan_status: 'clean', status: 'quarantined' }))).toBe('quarantined');
  });
});

describe('client upload rules (SEC-UP-2)', () => {
  it('knows types by declared type or extension, and HEIC', () => {
    expect(mimeOf({ name: 'a.JPG', type: '' })).toBe('image/jpeg');
    expect(mimeOf({ name: 'a.pdf', type: 'application/pdf' })).toBe('application/pdf');
    expect(mimeOf({ name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
    expect(mimeOf({ name: 'a.svg', type: 'image/svg+xml' })).toBeNull();
    expect(isHeic({ name: 'IMG_1.HEIC', type: '' })).toBe(true);
    expect(isHeic({ name: 'x', type: 'image/heif' })).toBe(true);
    expect(isHeic({ name: 'x.jpg', type: 'image/jpeg' })).toBe(false);
  });

  it('builds accept lists per purpose and checks limits', () => {
    expect(acceptFor('vehicle_photo')).toContain('image/heic');
    expect(acceptFor('vehicle_photo')).not.toContain('application/pdf');
    expect(acceptFor('service_evidence')).toContain('application/pdf');
    expect(acceptFor('issue_photo')).toContain('video/mp4');
    expect(checkFile('vehicle_document', { mime: 'application/pdf', size: 20 * 1024 * 1024 })).toBeNull();
    expect(checkFile('vehicle_document', { mime: 'application/pdf', size: 20 * 1024 * 1024 + 1 })).toBe('size');
    expect(checkFile('issue_photo', { mime: 'video/mp4', size: 1000, seconds: 15 })).toBeNull();
    expect(checkFile('vehicle_photo', { mime: 'image/png', size: 1000, pixels: 40_000_001 })).toBe('pixels');
  });
});
