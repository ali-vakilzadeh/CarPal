import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIFETIMES } from '../config';
import { SessionManager } from './manager';
import { encodeCommand, parseReply, RedisSessionStore, RespClient } from './redis';
import { LiteSessionStore } from './store';

const H = 3_600_000;

function setup() {
  const clock = { now: 1_000_000 };
  const store = new LiteSessionStore({ now: () => clock.now, sweepMs: 0 });
  const sessions = new SessionManager(store, DEFAULT_LIFETIMES, () => clock.now);
  return { clock, store, sessions };
}

const request = (id: string) => new Request('http://x/', { headers: { cookie: `__Host-cp_sid=${id}` } });

describe('SessionManager over the lite store', () => {
  it('saves and loads by cookie; ignores malformed ids', async () => {
    const { sessions } = setup();
    const r = sessions.create('en');
    await sessions.save(r);
    expect((await sessions.load(request(r.id)))?.locale).toBe('en');
    expect(await sessions.load(request('short'))).toBeNull();
    expect(await sessions.load(new Request('http://x/'))).toBeNull();
  });

  it('expires after 12 h idle, slides with activity, and ends after 7 days whatever the activity', async () => {
    const { sessions, clock } = setup();
    const r = sessions.create();
    await sessions.save(r);
    clock.now += 11 * H;
    expect(await sessions.get(r.id)).not.toBeNull();
    await sessions.update(r.id, () => {});
    clock.now += 11 * H;
    expect(await sessions.get(r.id)).not.toBeNull();
    clock.now += 13 * H;
    expect(await sessions.get(r.id)).toBeNull();

    const s = sessions.create();
    await sessions.save(s);
    for (let i = 0; i < 16; i++) {
      clock.now += 11 * H;
      await sessions.update(s.id, () => {});
    }
    expect(await sessions.get(s.id)).toBeNull();
  });

  it('serializes read-modify-write per session, so parallel updates are all kept', async () => {
    const { sessions } = setup();
    const r = sessions.create();
    await sessions.save(r);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sessions.update(r.id, async (s) => {
          await new Promise((res) => setTimeout(res, Math.random() * 3));
          s.intents.push({ id: String(i), type: 't', returnTo: '/', createdAt: 0 });
        }),
      ),
    );
    expect((await sessions.get(r.id))!.intents).toHaveLength(20);
  });

  it('rotation gives a new id and CSRF secret and deletes the old record', async () => {
    const { sessions } = setup();
    const old = sessions.create('fa');
    await sessions.save(old);
    const next = await sessions.rotate(old, (n) => (n.profile = { displayName: 'S' }));
    expect(next.id).not.toBe(old.id);
    expect(next.csrf).not.toBe(old.csrf);
    expect(next.locale).toBe('fa');
    expect(await sessions.get(old.id)).toBeNull();
    expect((await sessions.get(next.id))?.profile?.displayName).toBe('S');
  });

  it('touch writes lastSeenAt back at most once a minute', async () => {
    const { sessions, clock, store } = setup();
    const r = sessions.create();
    await sessions.save(r);
    clock.now += 30_000;
    await sessions.touch(r);
    expect((await store.get(r.id))!.lastSeenAt).toBe(1_000_000);
    clock.now += 31_000;
    await sessions.touch(r);
    expect((await store.get(r.id))!.lastSeenAt).toBe(1_061_000);
  });

  it('the lite store returns copies and sweeps expired entries', async () => {
    const { store, clock } = setup();
    const r = { id: 'a', createdAt: 0, lastSeenAt: 0, absoluteExpiresAt: 1e12, csrf: 'c', logins: [], intents: [] };
    await store.set(r, 1000);
    const got = (await store.get('a'))!;
    got.csrf = 'changed';
    expect((await store.get('a'))!.csrf).toBe('c');
    clock.now += 1001;
    store.sweep();
    expect(store.size).toBe(0);
  });
});

describe('Redis session store (minimal RESP client)', () => {
  it('encodes commands and parses every reply type, including partial buffers', () => {
    expect(encodeCommand(['SET', 'k', 'vä'])).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\nvä\r\n');
    const buf = Buffer.from('+OK\r\n:42\r\n$-1\r\n$3\r\nabc\r\n*2\r\n$1\r\na\r\n:1\r\n-ERR bad\r\n');
    const values: unknown[] = [];
    for (let at = 0, r; (r = parseReply(buf, at)); at = r.next) values.push(r.value);
    expect(values.slice(0, 5)).toEqual(['OK', 42, null, 'abc', ['a', 1]]);
    expect(values[5]).toBeInstanceOf(Error);
    expect(parseReply(Buffer.from('$5\r\nab'))).toBeUndefined();
  });

  let server: Server | undefined;
  afterEach(() => server?.close());

  it('stores, reads, expires and deletes records against a RESP server', async () => {
    // A tiny in-memory Redis: AUTH, SELECT, GET, SET … PX, DEL.
    const data = new Map<string, { v: string; until: number }>();
    const seen: string[][] = [];
    server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (let r; (r = parseReply(buf));) {
          buf = buf.subarray(r.next);
          const [cmd, ...args] = r.value as string[];
          seen.push([cmd!, ...args]);
          if (cmd === 'AUTH' || cmd === 'SELECT') socket.write('+OK\r\n');
          else if (cmd === 'SET') {
            data.set(args[0]!, { v: args[1]!, until: Date.now() + Number(args[3]) });
            socket.write('+OK\r\n');
          } else if (cmd === 'GET') {
            const e = data.get(args[0]!);
            socket.write(e && e.until > Date.now() ? `$${Buffer.byteLength(e.v)}\r\n${e.v}\r\n` : '$-1\r\n');
          } else if (cmd === 'DEL') socket.write(`:${data.delete(args[0]!) ? 1 : 0}\r\n`);
        }
      });
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    const store = new RedisSessionStore(new RespClient(`redis://:secret@127.0.0.1:${port}/2`));
    const record = { id: 'sid', createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2, csrf: 'c', locale: 'fa', logins: [], intents: [] };
    await store.set(record, 60_000);
    expect(await store.get('sid')).toEqual(record);
    expect(seen.slice(0, 2)).toEqual([
      ['AUTH', 'secret'],
      ['SELECT', '2'],
    ]);
    expect(seen.find((c) => c[0] === 'SET')).toEqual(['SET', 'cp:bff:sess:sid', JSON.stringify(record), 'PX', '60000']);
    await store.delete('sid');
    expect(await store.get('sid')).toBeNull();
    await store.set(record, 1);
    await new Promise((res) => setTimeout(res, 10));
    expect(await store.get('sid')).toBeNull();
    await store.close();
  });

  it('refuses non-redis URLs', () => {
    expect(() => new RespClient('rediss://x:6380')).toThrow(/redis:\/\//);
  });
});
