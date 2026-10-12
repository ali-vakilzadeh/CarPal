// W6 media processing (41 §2.4; 40 SEC-UP-2/3/5), run by the worker
// deployable in the system context: type sniffing (a mismatch quarantines),
// the malware check (lite: the EICAR signature stands in for a scanner),
// image decode + re-encode with sharp (removes EXIF and polyglot payloads)
// with display and thumbnail variants, MP4 duration limits, encryption at
// rest of documents and private media, then media.scan.completed.
// Lite-mode deviations: videos are not transcoded and PDFs are not
// sanitized (no ffmpeg / PDF sanitizer); HEIC (HEVC) cannot be decoded by
// the prebuilt sharp, so HEIC uploads fail processing.
import { Injectable } from '@nestjs/common';
import sharp, { type Metadata, type OverlayOptions } from 'sharp';
import type { Infra } from '#libs/infra/index.js';
import type { JobContext, JobOutcome } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { MAX_PIXELS, MAX_VIDEO_SECONDS } from '../domain/purposes.js';
import { containsMalwareSignature, mp4DurationSeconds, sniffType } from '../domain/sniff.js';
import { keys, type AssetRow } from '../infrastructure/assets.js';

type Region = { x: string; y: string; w: string; h: string };
/** core.background_jobs.input_summary of a redaction job (coordinates only, no personal data). */
type RedactionInput = { media_asset_id: string; decision: string; regions?: Region[] };

const DISPLAY_MAX = 2048;
const THUMB_MAX = 400;

type Outcome =
  | { scan: 'clean'; width: number | null; height: number | null; duration: number | null; thumbnail: string | null; exifStripped: boolean }
  | { scan: 'infected' | 'failed'; reason: string };

@Injectable()
export class MediaProcessor {
  constructor(
    private readonly tx: TxRunner,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Processes one uploaded asset; a no-op when it is not waiting for a scan. */
  async process(assetId: string): Promise<void> {
    const a = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('media.media_assets')
        .selectAll()
        .where('id', '=', assetId)
        .where('status', '=', 'active')
        .where('scan_status', '=', 'pending')
        .executeTakeFirst(),
    );
    if (!a) return;
    const outcome: Outcome = await this.#examine(a).catch((err: unknown) => {
      this.logger.warn({ err, media_asset_id: a.id }, 'media processing failed');
      return { scan: 'failed', reason: 'processing_error' } as const;
    });
    await this.tx.run({ actorType: 'system' }, async (scope) => {
      const updated = await scope.db
        .updateTable('media.media_assets')
        .set(
          outcome.scan === 'clean'
            ? {
                scan_status: 'clean',
                storage_reference: keys.original(a.id),
                thumbnail_reference: outcome.thumbnail,
                width: outcome.width,
                height: outcome.height,
                duration_seconds: outcome.duration,
                exif_stripped: outcome.exifStripped,
              }
            : { scan_status: outcome.scan, status: 'quarantined' },
        )
        .where('id', '=', a.id)
        .where('scan_status', '=', 'pending')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) return;
      await publishEvent(scope, {
        type: 'media.scan.completed',
        aggregateType: 'media_asset',
        aggregateId: a.id,
        payload: {
          media_asset_id: a.id,
          scan_status: outcome.scan,
          owner_type: a.owner_type,
          owner_id: a.owner_id,
          purpose: a.purpose,
          ...(outcome.scan === 'clean' ? {} : { reason: outcome.reason }),
        },
      });
    });
    // The raw upload is not kept: clean files live on as processed variants, quarantined ones are not served.
    if (outcome.scan === 'clean') await this.infra.storage.delete(keys.upload(a.id));
  }

  async #examine(a: AssetRow): Promise<Outcome> {
    const obj = await this.infra.storage.get(keys.upload(a.id));
    if (!obj) return { scan: 'failed', reason: 'missing_object' };
    const body = obj.body;
    if (containsMalwareSignature(body)) return { scan: 'infected', reason: 'malware_signature' };
    // SEC-UP-2: the bytes decide the type; a mismatch with the declaration quarantines the file.
    if (sniffType(body) !== a.mime_type) return { scan: 'failed', reason: 'type_mismatch' };
    const encrypt = a.encrypted_at_rest;
    const put = (key: string, data: Buffer, type: string) => this.infra.storage.put(key, data, type, { encrypt });
    if (a.media_type === 'image') {
      let meta: Metadata;
      try {
        meta = await sharp(body, { limitInputPixels: MAX_PIXELS }).metadata();
      } catch {
        return { scan: 'failed', reason: a.mime_type === 'image/heic' ? 'heic_unsupported' : 'undecodable_image' };
      }
      if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) return { scan: 'failed', reason: 'too_many_pixels' };
      // Re-encode (EXIF and other metadata dropped, orientation applied); HEIC becomes JPEG when decodable.
      const format = a.mime_type === 'image/png' ? 'png' : a.mime_type === 'image/webp' ? 'webp' : 'jpeg';
      const base = () => sharp(body, { limitInputPixels: MAX_PIXELS }).rotate();
      const original = await base().toFormat(format).toBuffer({ resolveWithObject: true });
      const display = await base()
        .resize({ width: DISPLAY_MAX, height: DISPLAY_MAX, fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer();
      const thumb = await base().resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
      await put(keys.original(a.id), original.data, `image/${format}`);
      await put(keys.display(a.id), display, 'image/webp');
      await put(keys.thumbnail(a.id), thumb, 'image/webp');
      return {
        scan: 'clean',
        width: Math.min(20_000, original.info.width),
        height: Math.min(20_000, original.info.height),
        duration: null,
        thumbnail: keys.thumbnail(a.id),
        exifStripped: true,
      };
    }
    if (a.media_type === 'video') {
      const seconds = mp4DurationSeconds(body);
      if (seconds === null || seconds > MAX_VIDEO_SECONDS)
        return { scan: 'failed', reason: seconds === null ? 'no_movie_header' : 'too_long' };
      await put(keys.original(a.id), body, a.mime_type);
      // Not transcoded in lite mode: metadata is not stripped, so the video never becomes publicly servable.
      return { scan: 'clean', width: null, height: null, duration: Math.max(1, Math.round(seconds)), thumbnail: null, exifStripped: false };
    }
    await put(keys.original(a.id), body, a.mime_type);
    return { scan: 'clean', width: null, height: null, duration: null, thumbnail: null, exifStripped: false };
  }

  /** media.redaction_decide jobs: blurs the chosen regions of the display variant (or records "not needed"). */
  async redact(ctx: JobContext): Promise<JobOutcome> {
    const input = ctx.job.input_summary as RedactionInput | null;
    if (!input?.media_asset_id) return { errorCode: 'INTERNAL' };
    const a = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('media.media_assets')
        .selectAll()
        .where('id', '=', input.media_asset_id)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (!a || a.scan_status !== 'clean') return { errorCode: 'MEDIA_NOT_READY' };
    let status: 'completed' | 'not_needed' | 'failed' = 'not_needed';
    if (input.decision === 'apply_regions' && input.regions?.length) {
      try {
        await this.#blur(a, input.regions);
        status = 'completed';
      } catch (err) {
        this.logger.warn({ err, media_asset_id: a.id }, 'redaction failed');
        status = 'failed';
      }
    }
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db.updateTable('media.media_assets').set({ redaction_status: status }).where('id', '=', a.id).execute(),
    );
    return status === 'failed' ? { errorCode: 'INTERNAL' } : { result: { type: 'media_asset', id: a.id } };
  }

  /** Blurs relative regions (0..1) of the display variant and rebuilds the thumbnail; the original stays owner-only. */
  async #blur(a: AssetRow, regions: Region[]): Promise<void> {
    const display = await this.infra.storage.get(keys.display(a.id));
    if (!display) throw new Error('no display variant');
    const { width = 0, height = 0 } = await sharp(display.body).metadata();
    const overlays: OverlayOptions[] = [];
    for (const r of regions) {
      const left = Math.min(width - 1, Math.floor(Number(r.x) * width));
      const top = Math.min(height - 1, Math.floor(Number(r.y) * height));
      const w = Math.max(1, Math.min(width - left, Math.ceil(Number(r.w) * width)));
      const h = Math.max(1, Math.min(height - top, Math.ceil(Number(r.h) * height)));
      const patch = await sharp(display.body).extract({ left, top, width: w, height: h }).blur(30).toBuffer();
      overlays.push({ input: patch, left, top });
    }
    const out = await sharp(display.body).composite(overlays).webp().toBuffer();
    await this.infra.storage.put(keys.display(a.id), out, 'image/webp', { encrypt: a.encrypted_at_rest });
    const thumb = await sharp(out).resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside' }).webp().toBuffer();
    await this.infra.storage.put(keys.thumbnail(a.id), thumb, 'image/webp', { encrypt: a.encrypted_at_rest });
  }
}
