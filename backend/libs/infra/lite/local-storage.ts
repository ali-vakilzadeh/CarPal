// Lite ObjectStorage: files under backend/.data/objects with a JSON sidecar,
// and HMAC-signed URLs served by a tiny local listener (CARPAL_STORAGE_PORT),
// standing in for media.carpal-usercontent.app (40 §1.1, SEC-UP-1/4).
// Signed PUT URLs fix Content-Type, Content-Length and SHA-256; signed GET
// URLs expire and carry the Content-Disposition. Objects put with
// { encrypt: true } are stored AES-256-GCM encrypted (iv | tag | ciphertext)
// and decrypted when read or served, like SSE-KMS in full mode.
// Browsers upload with a cross-origin signed PUT (SEC-UP-1) and the PWA reads
// private PDFs into a blob for its in-place preview, so configured web origins
// get CORS for PUT and GET (no credentials, nothing exposed; PWA DI-08).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import type { ObjectStorage, PresignedPut, PutOptions, StoredObjectInfo } from '../ports.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/;

export class LocalObjectStorage implements ObjectStorage {
  constructor(
    private readonly root: string,
    private readonly baseUrl: string,
    private readonly signingKey: Buffer,
    private readonly clock: () => number = Date.now,
    /** AES-256 key for objects put with { encrypt: true }. */
    private readonly encryptionKey: Buffer = createHash('sha256').update(signingKey).update('sse').digest(),
    /** Web origins allowed to call the listener from a browser (CARPAL_MEDIA_CORS_ORIGINS). */
    private readonly corsOrigins: readonly string[] = [],
  ) {
    mkdirSync(root, { recursive: true });
  }

  #path(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) throw new Error(`invalid object key ${JSON.stringify(key)}`);
    const p = resolve(this.root, ...key.split('/'));
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error('object key escapes the storage root');
    return p;
  }

  async put(key: string, body: Buffer, contentType: string, options: PutOptions = {}): Promise<StoredObjectInfo> {
    const p = this.#path(key);
    mkdirSync(dirname(p), { recursive: true });
    const info: StoredObjectInfo = {
      size: body.length,
      contentType,
      sha256: createHash('sha256').update(body).digest('base64'),
      ...(options.encrypt ? { encrypted: true } : {}),
    };
    let stored = body;
    if (options.encrypt) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      cipher.setAAD(Buffer.from(key));
      const ct = Buffer.concat([cipher.update(body), cipher.final()]);
      stored = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    }
    writeFileSync(p, stored);
    writeFileSync(`${p}.meta.json`, JSON.stringify(info));
    return info;
  }

  async get(key: string): Promise<{ body: Buffer; info: StoredObjectInfo } | null> {
    const info = await this.head(key);
    if (!info) return null;
    const raw = readFileSync(this.#path(key));
    if (!info.encrypted) return { body: raw, info };
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(raw.subarray(12, 28));
    return { body: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]), info };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const p = this.#path(key);
    if (!existsSync(`${p}.meta.json`)) return null;
    return JSON.parse(readFileSync(`${p}.meta.json`, 'utf8')) as StoredObjectInfo;
  }

  async delete(key: string): Promise<void> {
    const p = this.#path(key);
    rmSync(p, { force: true });
    rmSync(`${p}.meta.json`, { force: true });
  }

  #sign(fields: string[]): string {
    return createHmac('sha256', this.signingKey).update(fields.join('\n')).digest('base64url');
  }

  async presignPut(
    key: string,
    c: { contentType: string; contentLength: number; sha256: string; expiresInMs: number },
  ): Promise<PresignedPut> {
    this.#path(key);
    const exp = Math.floor((this.clock() + c.expiresInMs) / 1000);
    const sig = this.#sign(['PUT', key, String(exp), c.contentType, String(c.contentLength), c.sha256]);
    const url = `${this.baseUrl}/o/${key}?exp=${exp}&sig=${sig}`;
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': c.contentType, 'content-length': String(c.contentLength), 'x-amz-checksum-sha256': c.sha256 },
      expiresAt: new Date(exp * 1000),
    };
  }

  async presignGet(key: string, o: { expiresInMs: number; disposition?: 'inline' | 'attachment' }): Promise<string> {
    this.#path(key);
    const exp = Math.floor((this.clock() + o.expiresInMs) / 1000);
    const disposition = o.disposition ?? 'inline';
    const sig = this.#sign(['GET', key, String(exp), disposition]);
    return `${this.baseUrl}/o/${key}?exp=${exp}&d=${disposition}&sig=${sig}`;
  }

  #verify(fields: string[], sig: string | null, exp: string | null): boolean {
    if (!sig || !exp || !/^\d{1,12}$/.test(exp) || Number(exp) * 1000 < this.clock()) return false;
    const expected = Buffer.from(this.#sign(fields));
    const actual = Buffer.from(sig);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Handles one request to the local storage listener. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const cors = origin !== null && this.corsOrigins.includes(origin);
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'private, no-store',
      vary: 'Origin',
      ...(cors ? { 'access-control-allow-origin': origin } : {}),
    };
    const fail = (status: number): void => {
      res.writeHead(status, headers).end();
    };
    if (req.method === 'OPTIONS') {
      // CORS preflight: only for allowed origins and the two signed methods; the signature is checked on the request itself.
      const method = req.headers['access-control-request-method'];
      if (!cors || (method !== 'PUT' && method !== 'GET')) return fail(403);
      res
        .writeHead(204, {
          ...headers,
          'access-control-allow-methods': 'PUT, GET',
          'access-control-allow-headers': 'content-type, x-amz-checksum-sha256',
          'access-control-max-age': '600',
        })
        .end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://storage.local');
    const key = decodeURIComponent(url.pathname.replace(/^\/o\//, ''));
    if (!url.pathname.startsWith('/o/') || !KEY_PATTERN.test(key) || key.includes('..')) return fail(404);
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    if (req.method === 'PUT') {
      const type = req.headers['content-type'] ?? '';
      const len = req.headers['content-length'] ?? '';
      const sha = String(req.headers['x-amz-checksum-sha256'] ?? '');
      if (!this.#verify(['PUT', key, exp ?? '', type, len, sha], sig, exp)) return fail(403);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > Number(len)) return fail(400);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (body.length !== Number(len) || createHash('sha256').update(body).digest('base64') !== sha) return fail(400);
      await this.put(key, body, type);
      res.writeHead(200, headers).end();
      return;
    }
    if (req.method === 'GET') {
      const d = url.searchParams.get('d') ?? 'inline';
      if (!this.#verify(['GET', key, exp ?? '', d], sig, exp)) return fail(403);
      const obj = await this.get(key);
      if (!obj) return fail(404);
      res.writeHead(200, {
        ...headers,
        'content-type': obj.info.contentType,
        'content-length': String(obj.info.size),
        'content-disposition': d === 'attachment' ? 'attachment' : 'inline',
      });
      res.end(obj.body);
      return;
    }
    fail(405);
  }

  listen(port: number, host: string): Promise<Server> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    return new Promise((resolveListen) => server.listen(port, host, () => resolveListen(server)));
  }
}

export const objectsDir = (dataDir: string): string => join(dataDir, 'objects');
