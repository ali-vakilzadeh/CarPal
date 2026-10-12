// Shared helpers of the S4 integration tests: real taxonomy nodes, the
// two-phase upload through the local signed-URL listener, W6 drained through
// a worker on the same adapters, and link tokens read from the lite mail sink.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { uuidv7 } from '#libs/crypto/index.js';
import { LocalObjectStorage } from '#libs/infra/index.js';
import { createTestWorker, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
export type Json = Record<string, any>;

export const idem = (): Record<string, string> => ({ 'idempotency-key': uuidv7() });

export interface Nodes {
  brand: string;
  model: string;
  series: string;
  otherModel: string;
  system: string;
  task: string;
  otherTask: string;
  amenity: string;
  partCategory: string;
  fuel: string | null;
  engine: string | null;
}

/** Active taxonomy nodes with real parent chains (brand → model → series, system → task). */
export async function taxonomyNodes(app: TestApp): Promise<Nodes> {
  return app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
    const all = await db
      .selectFrom('taxonomy.taxonomy_nodes')
      .select(['id', 'type', 'parent_id'])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    const of = (type: string) => all.filter((n) => n.type === type);
    const series = of('vehicle_series').find((s) => all.some((m) => m.id === s.parent_id && m.type === 'vehicle_model'))!;
    const model = all.find((n) => n.id === series.parent_id)!;
    const brand = all.find((n) => n.id === model.parent_id)!;
    const otherModel = of('vehicle_model').find((m) => m.parent_id !== brand.id)!;
    const task = of('service_task').find((t) => all.some((s) => s.id === t.parent_id && s.type === 'service_system'))!;
    const otherTask = of('service_task').find((t) => t.parent_id !== task.parent_id)!;
    return {
      brand: brand.id,
      model: model.id,
      series: series.id,
      otherModel: otherModel.id,
      system: task.parent_id!,
      task: task.id,
      otherTask: otherTask.id,
      amenity: of('amenity')[0]!.id,
      partCategory: of('part_category')[0]!.id,
      fuel: of('fuel_type')[0]?.id ?? null,
      engine: of('engine_type')[0]?.id ?? null,
    };
  });
}

/** The token of the newest link mailed to `to` (SEC-LT-2: it is in the fragment). */
export function mailedToken(app: TestApp, to: string, template: string): string {
  const mail = app.mail(to, template).at(-1);
  if (!mail) throw new Error(`no ${template} mail to ${to}`);
  return mail.variables.link!.split('#')[1]!;
}

/** Media pipeline harness: storage listener, W6 worker and upload helpers. */
export class MediaHarness {
  private constructor(
    private readonly app: TestApp,
    readonly worker: INestApplicationContext,
    private readonly server: Server,
    readonly storageUrl: string,
  ) {}

  static async start(app: TestApp): Promise<MediaHarness> {
    const storage = app.infra.storage as LocalObjectStorage;
    const server = await storage.listen(0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    const worker = await createTestWorker({ infra: app.infra });
    return new MediaHarness(app, worker, server, `http://127.0.0.1:${port}`);
  }

  async close(): Promise<void> {
    await this.worker.close();
    this.server.close();
  }

  /** Signed URLs name the configured media origin; tests reach the listener on its ephemeral port. */
  local(url: string): string {
    return url.replace(this.app.config.http.mediaBaseUrl, this.storageUrl);
  }

  async init(token: string, o: { owner: { type: 'user' | 'organization'; id: string }; purpose: string; mime: string; bytes: Buffer }) {
    return this.app.request<Json>({
      method: 'POST',
      path: '/v1/media/uploads',
      token,
      headers: idem(),
      body: {
        purpose: o.purpose,
        owner: o.owner,
        mime_type: o.mime,
        file_size_bytes: o.bytes.length,
        checksum_sha256: createHash('sha256').update(o.bytes).digest('base64'),
      },
    });
  }

  async put(ticket: Json, bytes: Buffer, headers: Record<string, string> = {}): Promise<number> {
    const res = await fetch(this.local(ticket.url), { method: 'PUT', headers: { ...ticket.headers, ...headers }, body: bytes });
    return res.status;
  }

  async complete(token: string, uploadId: string) {
    return this.app.request<Json>({ method: 'POST', path: `/v1/media/uploads/${uploadId}/complete`, token, headers: idem() });
  }

  /** Waits until W6 has processed every queued upload. */
  async drain(): Promise<void> {
    await this.app.infra.jobs.idle();
  }

  /** init → PUT → complete → W6; returns the asset after processing. */
  async upload(
    token: string,
    o: { owner: { type: 'user' | 'organization'; id: string }; purpose: string; mime: string; bytes: Buffer },
  ): Promise<Json> {
    const ticket = await this.init(token, o);
    if (ticket.status !== 201) throw new Error(`upload_init ${ticket.status} ${ticket.text}`);
    const put = await this.put(ticket.body, o.bytes);
    if (put !== 200) throw new Error(`PUT ${put}`);
    const done = await this.complete(token, ticket.body.upload_id);
    if (done.status !== 202) throw new Error(`upload_complete ${done.status} ${done.text}`);
    await this.drain();
    return (await this.app.request<Json>({ path: `/v1/media/${ticket.body.upload_id}`, token })).body;
  }
}
