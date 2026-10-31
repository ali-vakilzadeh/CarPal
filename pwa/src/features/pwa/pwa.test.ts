// P12.T1/T3: the install prompt rule, the manifest, and web push (status, subscribe with the 409 "other account"
// case, unsubscribe = revoke + drop the browser subscription) against injected browser parts.
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import {
  EMPTY_INSTALL_RECORD,
  QUIET_DAYS,
  parseInstallRecord,
  shouldOfferInstall,
  withDismissal,
  withInstalled,
  withVisit,
} from './install';
import { MANIFEST_ICONS, manifestFor } from './manifest';
import {
  parsePushRecord,
  pushStatusOf,
  shouldOfferPush,
  subscribePush,
  unsubscribePush,
  vapidKeyBytes,
  type PushEnv,
  type PushRecord,
} from './push';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-31T10:00:00Z');
const base = { now: NOW, installable: true, standalone: false, signedIn: true };

describe('install prompt rule', () => {
  it('appears from the second signed-in visit while the browser offers installation', () => {
    const one = withVisit(EMPTY_INSTALL_RECORD);
    expect(shouldOfferInstall(one, base)).toBe(false);
    const two = withVisit(one);
    expect(shouldOfferInstall(two, base)).toBe(true);
    expect(shouldOfferInstall(two, { ...base, installable: false })).toBe(false);
    expect(shouldOfferInstall(two, { ...base, standalone: true })).toBe(false);
    expect(shouldOfferInstall(two, { ...base, signedIn: false })).toBe(false);
    expect(shouldOfferInstall(withInstalled(two), base)).toBe(false);
  });

  it('stays away for 30 days after a dismissal', () => {
    const r = withDismissal(withVisit(withVisit(EMPTY_INSTALL_RECORD)), NOW);
    expect(shouldOfferInstall(r, { ...base, now: NOW + (QUIET_DAYS - 1) * DAY })).toBe(false);
    expect(shouldOfferInstall(r, { ...base, now: NOW + QUIET_DAYS * DAY })).toBe(true);
  });

  it('reads stored records defensively', () => {
    expect(parseInstallRecord(null)).toEqual(EMPTY_INSTALL_RECORD);
    expect(parseInstallRecord('not json')).toEqual(EMPTY_INSTALL_RECORD);
    expect(parseInstallRecord('{"visits":-3,"dismissedAt":"x","installed":"yes"}')).toEqual(EMPTY_INSTALL_RECORD);
    expect(parseInstallRecord(JSON.stringify({ visits: 2, dismissedAt: NOW, installed: true }))).toEqual({
      visits: 2,
      dismissedAt: NOW,
      installed: true,
    });
  });
});

describe('web app manifest', () => {
  it('names the app in the page language, starts in that locale and is installable (standalone, 192 and 512 icons)', () => {
    const fa = manifestFor('fa');
    expect(fa).toMatchObject({ name: 'کارپال', lang: 'fa', dir: 'rtl', start_url: '/fa?source=pwa', display: 'standalone', scope: '/' });
    expect(manifestFor('en')).toMatchObject({ name: 'CarPal', lang: 'en', dir: 'ltr', start_url: '/en?source=pwa' });
    const sizes = MANIFEST_ICONS.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(MANIFEST_ICONS.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(fa.theme_color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ---------- web push ----------

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function fakeEnv(o: { permission?: NotificationPermission; existing?: boolean; record?: PushRecord | null } = {}) {
  let record = o.record ?? null;
  let current: { endpoint: string; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => unknown } | null = null;
  let n = 0;
  const makeSub = () => {
    const endpoint = `https://push.example/ep-${++n}`;
    const sub = {
      endpoint,
      unsubscribe: vi.fn(async () => {
        if (current === sub) current = null;
        return true;
      }),
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    };
    return sub;
  };
  if (o.existing) current = makeSub();
  const subscribe = vi.fn(async () => (current = makeSub()));
  const registration = { pushManager: { getSubscription: async () => current, subscribe } } as unknown as ServiceWorkerRegistration;
  const env: PushEnv = {
    requestPermission: vi.fn(async () => o.permission ?? 'granted'),
    registration: async () => registration,
    read: () => record,
    write: (r) => {
      record = r;
    },
    appVersion: '0.1.0',
  };
  return { env, subscribe, current: () => current, record: () => record };
}

function fakeApi(register: (body: unknown) => unknown, revoke: (id: string) => unknown = () => ({ ok: true })) {
  const calls: { op: string; args: unknown }[] = [];
  const api = {
    api: async (op: string, args: { body?: unknown; path?: { push_token_id: string } }) => {
      calls.push({ op, args });
      if (op === 'push_tokens.register') return register(args.body);
      if (op === 'push_tokens.revoke') return revoke(args.path!.push_token_id);
      throw new Error(op);
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('web push', () => {
  it('derives the status from support, permission and whose subscription this browser holds', () => {
    const record = { userId: 'u1', tokenId: 't1', endpoint: 'e' };
    expect(pushStatusOf({ supported: false, permission: null, record, userId: 'u1' })).toBe('unsupported');
    expect(pushStatusOf({ supported: true, permission: 'denied', record, userId: 'u1' })).toBe('denied');
    expect(pushStatusOf({ supported: true, permission: 'granted', record, userId: 'u1' })).toBe('on');
    expect(pushStatusOf({ supported: true, permission: 'granted', record, userId: 'u2' })).toBe('off');
    expect(pushStatusOf({ supported: true, permission: 'default', record: null, userId: 'u1' })).toBe('off');
    expect(shouldOfferPush('off', false)).toBe(true);
    expect(shouldOfferPush('off', true)).toBe(false);
    expect(shouldOfferPush('on', false)).toBe(false);
    expect(parsePushRecord('{"userId":"u","tokenId":"t","endpoint":"e"}')).toEqual({ userId: 'u', tokenId: 't', endpoint: 'e' });
    expect(parsePushRecord('{"userId":1}')).toBeNull();
  });

  it('decodes the base64url VAPID key into the 65-byte P-256 point', () => {
    const bytes = vapidKeyBytes(KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });

  it('subscribes and registers the subscription JSON as a web push token for this user', async () => {
    const f = fakeEnv();
    const { api, calls } = fakeApi(() => ({ push_token_id: 'tok-1' }));
    expect(await subscribePush(api, f.env, { userId: 'u1', vapidKey: KEY, locale: 'en' })).toBe('on');
    expect(f.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const body = calls[0]!.args as { body: { platform: string; token: string; locale: string; app_version: string } };
    expect(body.body.platform).toBe('web');
    expect(JSON.parse(body.body.token)).toMatchObject({ endpoint: 'https://push.example/ep-1', keys: { p256dh: 'p', auth: 'a' } });
    expect(body.body.locale).toBe('en');
    expect(f.record()).toEqual({ userId: 'u1', tokenId: 'tok-1', endpoint: 'https://push.example/ep-1' });
  });

  it('stops at a denied permission and reports a token of another account (409 DUPLICATE), then starts fresh on request', async () => {
    const denied = fakeEnv({ permission: 'denied' });
    expect(await subscribePush(fakeApi(() => ({})).api, denied.env, { userId: 'u1', vapidKey: KEY, locale: 'fa' })).toBe('denied');
    expect(denied.subscribe).not.toHaveBeenCalled();

    const f = fakeEnv({ existing: true });
    const dup = new ApiProblem(409, { code: 'DUPLICATE', title: 'Duplicate' });
    let first = true;
    const { api } = fakeApi(() => {
      if (first) {
        first = false;
        throw dup;
      }
      return { push_token_id: 'tok-2' };
    });
    expect(await subscribePush(api, f.env, { userId: 'u1', vapidKey: KEY, locale: 'fa' })).toBe('other-account');
    expect(f.record()).toBeNull();
    const old = f.current()!;
    expect(await subscribePush(api, f.env, { userId: 'u1', vapidKey: KEY, locale: 'fa', fresh: true })).toBe('on');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(f.record()).toMatchObject({ userId: 'u1', tokenId: 'tok-2', endpoint: 'https://push.example/ep-2' });
  });

  it('turns off: revokes the token (a gone token is fine), forgets it and drops the browser subscription', async () => {
    const f = fakeEnv({ existing: true, record: { userId: 'u1', tokenId: 'tok-1', endpoint: 'x' } });
    const sub = f.current()!;
    const { api, calls } = fakeApi(
      () => ({}),
      () => {
        throw new ApiProblem(404, { code: 'NOT_FOUND', title: 'Not found' });
      },
    );
    await unsubscribePush(api, f.env);
    expect(calls.map((c) => c.op)).toEqual(['push_tokens.revoke']);
    expect(f.record()).toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('after an account switch drops the old subscription locally without calling the API', async () => {
    const f = fakeEnv({ existing: true, record: { userId: 'old', tokenId: 'tok-1', endpoint: 'x' } });
    await unsubscribePush(null, f.env);
    expect(f.record()).toBeNull();
    expect(f.current()).toBeNull();
  });
});
