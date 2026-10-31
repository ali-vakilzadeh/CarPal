// The upload state machine (P7.T2, Docs/40 §17, SEC-UP-1..3): check → (convert HEIC) → hash → media.upload_init →
// signed PUT with progress → media.upload_complete → poll media.get until the scan is done. Every step reports a new
// state; a failure ends in 'failed' with a reason the screen can explain. The browser parts (decoding, hashing, the
// PUT) are injected, so the machine runs in unit tests against a mocked fetch.
//
// Polling (BA-06): W6 scans asynchronously; media.get answers 404 while the asset is not visible yet, which means
// "not ready", not "gone". The client honours CarPal-Poll-After-Ms and otherwise waits 1 s, growing to 5 s, for at
// most two minutes ('timeout': the file may still turn up, the user can check again).
import type { MediaAsset, UploadPurpose, UploadTicket } from '@carpal/api-contracts';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { checkFile, isHeic, kindOf, mimeOf, type CheckProblem, type UploadKind, type UploadMime } from './policy';

export type UploadPhase = 'checking' | 'converting' | 'hashing' | 'sending' | 'processing' | 'ready' | 'failed';

export type UploadFailure =
  | CheckProblem
  | 'heic'
  | 'unreadable'
  | 'refused'
  | 'rateLimited'
  | 'network'
  | 'expired'
  | 'mismatch'
  | 'infected'
  | 'scanFailed'
  | 'quarantined'
  | 'timeout';

export interface UploadState {
  phase: UploadPhase;
  /** 0..1 while sending. */
  progress: number;
  kind: UploadKind | null;
  mime: UploadMime | null;
  /** The file actually sent (the JPEG for a converted HEIC photo). */
  file: File;
  converted: boolean;
  uploadId: string | null;
  asset: MediaAsset | null;
  failure: UploadFailure | null;
}

export interface Inspection {
  pixels?: number | null;
  seconds?: number | null;
  /** The browser could not decode an image or read a video's metadata. */
  unreadable?: boolean;
}

export interface UploadDeps {
  api: ApiClient;
  /** Decodes enough of the file to know its pixels or duration. */
  inspect: (file: File, kind: UploadKind) => Promise<Inspection>;
  /** HEIC/HEIF → JPEG in the browser; throws when it cannot. */
  convertHeic: (file: File) => Promise<File>;
  /** Base64 SHA-256 of the bytes (40 UploadInit.checksum_sha256). */
  sha256: (file: File) => Promise<string>;
  /** The signed PUT with the ticket's headers; resolves with the HTTP status. */
  put: (ticket: UploadTicket, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal) => Promise<number>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface UploadRequest {
  file: File;
  purpose: UploadPurpose;
  /** The uploading user (UploadInit.owner), or the organization the file belongs to (ownerType). */
  ownerId: string;
  /** 'organization' for files of an organization the user is a member of, e.g. a fleet driver's issue photos (P12). */
  ownerType?: 'user' | 'organization';
  signal?: AbortSignal;
}

export const POLL = { firstMs: 1_000, maxMs: 5_000, factor: 1.5, timeoutMs: 120_000 } as const;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

export function initialState(file: File): UploadState {
  return {
    phase: 'checking',
    progress: 0,
    kind: null,
    mime: null,
    file,
    converted: false,
    uploadId: null,
    asset: null,
    failure: null,
  };
}

/** What a finished scan means for the upload: still pending, ready, or why it failed. */
export function scanOutcome(asset: MediaAsset): 'pending' | 'ready' | UploadFailure {
  if (asset.status === 'quarantined') return 'quarantined';
  if (asset.status === 'removed') return 'scanFailed';
  if (asset.scan_status === 'infected') return 'infected';
  if (asset.scan_status === 'failed') return 'scanFailed';
  return asset.scan_status === 'clean' ? 'ready' : 'pending';
}

function failureOf(err: unknown): UploadFailure {
  if (!(err instanceof ApiProblem)) return 'network';
  if (err.code === 'NETWORK') return 'network';
  if (err.status === 429 || err.code === 'PAUSED') return 'rateLimited';
  if (err.code === 'UPLOAD_MISMATCH') return 'mismatch';
  if (err.status === 410 || err.code === 'LINK_EXPIRED') return 'expired';
  if (err.status === 422) return 'refused';
  return 'network';
}

/** Runs one upload to the end; `emit` receives every state. Returns the final state (ready or failed). */
export async function runUpload(req: UploadRequest, deps: UploadDeps, emit: (s: UploadState) => void): Promise<UploadState> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let state = initialState(req.file);
  const set = (patch: Partial<UploadState>) => {
    state = { ...state, ...patch };
    emit(state);
    return state;
  };
  const fail = (failure: UploadFailure) => set({ phase: 'failed', failure });
  set({});

  // 1. What it is; HEIC photos become JPEG first (GD-32).
  let file = req.file;
  if (isHeic(file)) {
    set({ phase: 'converting' });
    try {
      file = await deps.convertHeic(file);
    } catch {
      return fail('heic');
    }
    set({ file, converted: true, phase: 'checking' });
  }
  const mime = mimeOf(file);
  const kind = mime ? kindOf(mime) : null;
  set({ mime, kind });
  const early = checkFile(req.purpose, { mime, size: file.size });
  if (early) return fail(early);
  if (kind === 'pdf' && !(await looksLikePdf(file))) return fail('type');
  if (kind !== 'pdf') {
    const seen = await deps.inspect(file, kind!).catch(() => ({ unreadable: true }) as Inspection);
    if (seen.unreadable) return fail('unreadable');
    const problem = checkFile(req.purpose, { mime, size: file.size, pixels: seen.pixels ?? null, seconds: seen.seconds ?? null });
    if (problem) return fail(problem);
  }

  // 2. Checksum and ticket (SEC-UP-1).
  set({ phase: 'hashing' });
  let checksum: string;
  try {
    checksum = await deps.sha256(file);
  } catch {
    return fail('unreadable');
  }
  let ticket: UploadTicket;
  try {
    ticket = await deps.api.api('media.upload_init', {
      body: {
        purpose: req.purpose,
        owner: { type: req.ownerType ?? 'user', id: req.ownerId },
        mime_type: mime!,
        file_size_bytes: file.size,
        checksum_sha256: checksum,
      },
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (err) {
    return fail(failureOf(err));
  }
  set({ uploadId: ticket.upload_id, phase: 'sending', progress: 0 });

  // 3. The bytes go straight to storage with the ticket's exact URL and headers (backend S9c).
  try {
    const status = await deps.put(ticket, file, (progress) => set({ progress }), req.signal);
    if (status === 403) return fail('expired');
    if (status < 200 || status >= 300) return fail('network');
  } catch {
    return fail('network');
  }
  set({ progress: 1, phase: 'processing' });

  // 4. Finalize, then wait for the scan.
  let asset: MediaAsset;
  try {
    asset = await deps.api.api('media.upload_complete', {
      path: { upload_id: ticket.upload_id },
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (err) {
    return fail(failureOf(err));
  }
  set({ asset });
  return waitForScan(asset.id, state, set, fail, deps, sleep, now, req.signal);
}

/** Polls media.get until the scan is done (also used by "Check again" after a timeout). */
export async function waitForScan(
  mediaId: string,
  state: UploadState,
  set: (patch: Partial<UploadState>) => UploadState,
  fail: (f: UploadFailure) => UploadState,
  deps: Pick<UploadDeps, 'api'>,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<UploadState> {
  const started = now();
  let delay: number = POLL.firstMs;
  let last = state.asset;
  for (;;) {
    if (last) {
      const outcome = scanOutcome(last);
      if (outcome === 'ready') return set({ phase: 'ready', asset: last });
      if (outcome !== 'pending') return fail(outcome);
    }
    if (now() - started > POLL.timeoutMs) return fail('timeout');
    let pollAfter: number | null = null;
    try {
      await sleep(delay, signal);
      const res = await deps.api.call('media.get', { path: { media_id: mediaId }, ...(signal ? { signal } : {}) });
      last = res.data;
      pollAfter = res.pollAfterMs;
      set({ asset: last });
    } catch (err) {
      if (signal?.aborted) throw err;
      // 404 right after upload_complete: not visible yet (BA-06). Network hiccups: keep trying until the timeout.
      if (err instanceof ApiProblem && err.status !== 404 && err.code !== 'NETWORK' && err.status < 500) return fail('scanFailed');
    }
    delay = pollAfter ?? Math.min(POLL.maxMs, Math.round(delay * POLL.factor));
  }
}

/** Reads the first bytes: a PDF starts with "%PDF-" (the server checks the real type too, SEC-UP-2). */
async function looksLikePdf(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head) === '%PDF-';
  } catch {
    return false;
  }
}
