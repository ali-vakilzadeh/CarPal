// Web push in the browser (P12.T3, DI-11 decided: consumer web push is built). This browser's subscription goes to
// the backend as a push token: push_tokens.register { platform: 'web', token: the PushSubscription JSON } (the push
// sender needs the endpoint and keys). The token id is kept per browser with the user it belongs to, so a logout —
// and an account switch — revokes it (push_tokens.revoke, BA-18). A token the backend already knows for another
// account answers 409 DUPLICATE: the user may then start a new subscription for this account (the old endpoint is
// unsubscribed, so the other account stops receiving pushes here). Categories follow the account's Push column of
// the notification matrix: the contract has one push channel for app and browser (DI-66).
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';

export const PUSH_STORE_KEY = 'cp:pwa:push';
export const PUSH_OFFER_KEY = 'cp:pwa:push-offer';

export interface PushRecord {
  userId: string;
  tokenId: string;
  endpoint: string;
}

export type PushStatus =
  /** No service worker, Push API or notifications in this browser, or no VAPID key in this deployment. */
  | 'unsupported'
  /** The user blocked notifications for this site (only the browser's settings can undo it). */
  | 'denied'
  | 'off'
  | 'on';

export type SubscribeOutcome = 'on' | 'denied' | 'unsupported' | 'other-account' | 'failed';

export function parsePushRecord(raw: string | null): PushRecord | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PushRecord>;
    return typeof o.userId === 'string' && typeof o.tokenId === 'string' && typeof o.endpoint === 'string'
      ? { userId: o.userId, tokenId: o.tokenId, endpoint: o.endpoint }
      : null;
  } catch {
    return null;
  }
}

export function pushStatusOf(o: {
  supported: boolean;
  permission: NotificationPermission | null;
  record: PushRecord | null;
  userId: string | null;
}): PushStatus {
  if (!o.supported) return 'unsupported';
  if (o.permission === 'denied') return 'denied';
  return o.record && o.userId && o.record.userId === o.userId && o.permission === 'granted' ? 'on' : 'off';
}

/** The offer after a benefiting action (Docs/22: after the first appointment request), unless answered before. */
export function shouldOfferPush(status: PushStatus, offerAnswered: boolean): boolean {
  return status === 'off' && !offerAnswered;
}

/** base64url VAPID key → the bytes PushManager.subscribe takes. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The browser parts push needs; injected so the logic is testable without a browser. */
export interface PushEnv {
  requestPermission(): Promise<NotificationPermission>;
  registration(): Promise<ServiceWorkerRegistration | null>;
  read(): PushRecord | null;
  write(r: PushRecord | null): void;
  appVersion: string;
}

export function browserPushEnv(appVersion: string): PushEnv {
  return {
    requestPermission: () => Notification.requestPermission(),
    registration: async () => {
      if (!('serviceWorker' in navigator)) return null;
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
      return Promise.race([navigator.serviceWorker.ready, timeout]);
    },
    read: () => parsePushRecord(localStorage.getItem(PUSH_STORE_KEY)),
    write: (r) => (r ? localStorage.setItem(PUSH_STORE_KEY, JSON.stringify(r)) : localStorage.removeItem(PUSH_STORE_KEY)),
    appVersion,
  };
}

/** Whether this browser and deployment can do web push at all. */
export function pushSupported(vapidKey: string | null): boolean {
  return (
    !!vapidKey &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function register(api: ApiClient, env: PushEnv, sub: PushSubscription, userId: string, locale: string): Promise<SubscribeOutcome> {
  try {
    const res = await api.api('push_tokens.register', {
      body: {
        platform: 'web',
        token: JSON.stringify(sub.toJSON()),
        app_version: env.appVersion.slice(0, 20),
        locale: locale === 'en' ? 'en' : 'fa',
      },
    });
    env.write({ userId, tokenId: res.push_token_id, endpoint: sub.endpoint });
    return 'on';
  } catch (err) {
    if (err instanceof ApiProblem && err.code === 'DUPLICATE') return 'other-account';
    return 'failed';
  }
}

/**
 * Turns web push on for the signed-in user: permission (after the user's click), the browser subscription, then the
 * push token. `fresh` drops an existing subscription first (the 409 "linked to another account" case).
 */
export async function subscribePush(
  api: ApiClient,
  env: PushEnv,
  o: { userId: string; vapidKey: string; locale: string; fresh?: boolean },
): Promise<SubscribeOutcome> {
  const permission = await env.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'failed';
  const reg = await env.registration();
  if (!reg) return 'unsupported';
  try {
    let sub = await reg.pushManager.getSubscription();
    if (sub && o.fresh) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(o.vapidKey) });
    return await register(api, env, sub, o.userId, o.locale);
  } catch {
    return 'failed';
  }
}

/** Turns web push off: the push token is revoked (a gone token is fine) and the browser subscription dropped. */
export async function unsubscribePush(api: ApiClient | null, env: PushEnv): Promise<void> {
  const record = env.read();
  if (record && api) {
    await api.api('push_tokens.revoke', { path: { push_token_id: record.tokenId } }).catch((err: unknown) => {
      if (!(err instanceof ApiProblem && err.status === 404)) throw err;
    });
  }
  env.write(null);
  const reg = await env.registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => undefined);
}
