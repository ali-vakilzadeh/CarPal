// Redis session store (GD-08 'full'; written, not verified against a real Redis — OQ-06). Uses a minimal RESP2
// client over node:net (GET, SET PX, DEL, AUTH, SELECT) instead of a client library, so the BFF keeps no extra
// dependency. Keys: cp:bff:sess:<id>.
import { connect, type Socket } from 'node:net';
import type { SessionStore } from './store';
import type { SessionRecord } from './types';

const PREFIX = 'cp:bff:sess:';

type Reply = string | number | null | Reply[] | Error;

/** Encodes one command as a RESP2 array of bulk strings. */
export function encodeCommand(args: readonly string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

/** Parses one RESP2 reply from `buf` at `offset`; undefined when the buffer does not hold a complete reply yet. */
export function parseReply(buf: Buffer, offset = 0): { value: Reply; next: number } | undefined {
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd < 0) return undefined;
  const type = String.fromCharCode(buf[offset]!);
  const line = buf.toString('utf8', offset + 1, lineEnd);
  const after = lineEnd + 2;
  switch (type) {
    case '+':
      return { value: line, next: after };
    case '-':
      return { value: new Error(line), next: after };
    case ':':
      return { value: Number(line), next: after };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return undefined;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, next: after };
      const items: Reply[] = [];
      let pos = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, pos);
        if (!r) return undefined;
        items.push(r.value);
        pos = r.next;
      }
      return { value: items, next: pos };
    }
    default:
      throw new Error(`RESP: unexpected type byte ${JSON.stringify(type)}`);
  }
}

/** One connection, commands answered in order (RESP is pipelined FIFO). Reconnects lazily after a failure. */
export class RespClient {
  #socket: Socket | undefined;
  #ready: Promise<void> | undefined;
  #buffer = Buffer.alloc(0);
  readonly #pending: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  readonly #url: URL;

  constructor(url: string) {
    this.#url = new URL(url);
    if (this.#url.protocol !== 'redis:')
      throw new Error('CARPAL_PWA_REDIS_URL must be a redis:// URL (rediss:// is not supported by the minimal client)');
  }

  async command(...args: string[]): Promise<Reply> {
    await this.#connect();
    return this.#send(args);
  }

  #send(args: readonly string[]): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#socket!.write(encodeCommand(args));
    });
  }

  #connect(): Promise<void> {
    this.#ready ??= new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.#url.hostname, port: Number(this.#url.port || 6379) });
      this.#socket = socket;
      socket.once('connect', () => {
        const init: Promise<Reply>[] = [];
        const user = decodeURIComponent(this.#url.username);
        const password = decodeURIComponent(this.#url.password);
        if (password) init.push(this.#send(user ? ['AUTH', user, password] : ['AUTH', password]));
        const db = this.#url.pathname.slice(1);
        if (db) init.push(this.#send(['SELECT', db]));
        Promise.all(init)
          .then((replies) => {
            const err = replies.find((r) => r instanceof Error);
            if (err) reject(err as Error);
            else resolve();
          })
          .catch(reject);
      });
      socket.on('data', (chunk: Buffer) => this.#onData(chunk));
      socket.on('error', (err) => this.#fail(err, reject));
      socket.on('close', () => this.#fail(new Error('Redis connection closed'), reject));
    });
    return this.#ready;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let offset = 0;
    for (;;) {
      const r = parseReply(this.#buffer, offset);
      if (!r) break;
      offset = r.next;
      this.#pending.shift()?.resolve(r.value);
    }
    this.#buffer = this.#buffer.subarray(offset);
  }

  #fail(err: Error, reject: (e: Error) => void): void {
    reject(err);
    for (const p of this.#pending.splice(0)) p.reject(err);
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#ready = undefined;
    this.#buffer = Buffer.alloc(0);
  }

  async close(): Promise<void> {
    this.#socket?.end();
    this.#socket = undefined;
    this.#ready = undefined;
  }
}

const check = (r: Reply): Reply => {
  if (r instanceof Error) throw r;
  return r;
};

export class RedisSessionStore implements SessionStore {
  constructor(private readonly client: Pick<RespClient, 'command' | 'close'>) {}

  async get(id: string): Promise<SessionRecord | null> {
    const r = check(await this.client.command('GET', PREFIX + id));
    return typeof r === 'string' ? (JSON.parse(r) as SessionRecord) : null;
  }

  async set(record: SessionRecord, ttlMs: number): Promise<void> {
    check(await this.client.command('SET', PREFIX + record.id, JSON.stringify(record), 'PX', String(Math.max(1, Math.ceil(ttlMs)))));
  }

  async delete(id: string): Promise<void> {
    check(await this.client.command('DEL', PREFIX + id));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
