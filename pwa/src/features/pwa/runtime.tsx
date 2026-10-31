'use client';
// The PWA runtime of every page (P12.T1-T3), mounted once by the app providers:
//   - registers /sw.js in production builds (next dev keeps the network to itself: HMR, fresh chunks);
//   - the update flow: a new worker waits until the user picks "Reload" in the update banner, then takes over and
//     the page reloads once (no half-old, half-new page);
//   - tells the worker who is signed in (it keeps private copies for that user only and wipes them for anyone else);
//   - the sign-out steps: revoke this browser's push token while the session exists, then remove every private copy
//     (acceptance: after logout no private data remains in caches);
//   - a push subscription of another account (account switch) is dropped on this browser;
//   - the offline banner, and the beforeinstallprompt event for the header's install button.
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { addLogoutStep, useSession } from '@/lib/api/session';
import { useApiClient } from '@/lib/api/query';
import { useLocale, useT } from '@/lib/i18n/client';
import { isPrivateCache, type PageMessage } from '@/sw/protocol';
import { OFFLINE_SECTIONS } from '@/sw/routes';
import packageJson from '../../../package.json';
import { browserPushEnv, unsubscribePush } from './push';

export const APP_VERSION = packageJson.version;

// ---- install prompt event (fired once, early: captured at module load) ----

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installEvent: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    notifyInstall();
  });
}

export function useInstallEvent(): InstallPromptEvent | null {
  return useSyncExternalStore(
    (l) => {
      installListeners.add(l);
      return () => installListeners.delete(l);
    },
    () => installEvent,
    () => null,
  );
}

export function forgetInstallEvent(): void {
  installEvent = null;
  notifyInstall();
}

// ---- web push state (this browser's subscription record and permission) ----

const PUSH_EVENT = 'cp:push-changed';

export function subscribePushChanges(l: () => void): () => void {
  window.addEventListener(PUSH_EVENT, l);
  window.addEventListener('storage', l);
  return () => {
    window.removeEventListener(PUSH_EVENT, l);
    window.removeEventListener('storage', l);
  };
}

export function notifyPushChanged(): void {
  window.dispatchEvent(new Event(PUSH_EVENT));
}

// ---- online state ----

export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('online', l);
      window.addEventListener('offline', l);
      return () => {
        window.removeEventListener('online', l);
        window.removeEventListener('offline', l);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

// ---- worker helpers ----

export function postToWorker(message: PageMessage): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.controller?.postMessage(message);
  void navigator.serviceWorker.getRegistration().then((reg) => reg?.active?.postMessage(message));
}

/** Removes every cache that may hold private data (user copies, public pages with the session view). */
export async function clearPrivateCaches(): Promise<void> {
  postToWorker({ type: 'cp:logout' });
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(names.filter(isPrivateCache).map((n) => caches.delete(n)));
}

interface ScriptUrlPolicy {
  createScriptURL(url: string): unknown;
}
let swPolicy: ScriptUrlPolicy | null | undefined;

/**
 * The worker's script URL under Trusted Types (the page CSP requires them): a policy named 'carpal-sw' (admitted by
 * the CSP, src/server/security-headers.ts) that returns exactly '/sw.js' and refuses anything else.
 */
export function workerScriptUrl(): string {
  if (swPolicy === undefined) {
    const tt = (
      window as unknown as { trustedTypes?: { createPolicy(n: string, r: { createScriptURL(u: string): string }): ScriptUrlPolicy } }
    ).trustedTypes;
    swPolicy =
      tt?.createPolicy('carpal-sw', {
        createScriptURL: (u) => {
          if (u === '/sw.js') return u;
          throw new TypeError('script URL refused');
        },
      }) ?? null;
  }
  return (swPolicy ? swPolicy.createScriptURL('/sw.js') : '/sw.js') as string;
}

/** The user chose "Reload" in the update bar: the next controller change reloads the page. */
let updateAccepted = false;

function swEnabled(): boolean {
  return process.env.NODE_ENV === 'production' && typeof window !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
}

export function PwaRuntime() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const online = useOnline();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Only a session the browser actually read (not a page's seed, which may be a stored copy or the cookie-free
  // offline page) tells the worker who is signed in: a wrong "signed out" would wipe the offline copies.
  const confirmed = session.dataUpdatedAt > 0 && session.status === 'success';
  const userId = !confirmed ? undefined : session.data?.signed_in ? (session.data.user?.id ?? null) : null;

  // Registration and the update flow.
  useEffect(() => {
    if (!swEnabled()) return;
    let reloading = false;
    const sw = navigator.serviceWorker;
    const hadController = !!sw.controller;
    const onController = () => {
      // The first worker claiming the page is no update; a replaced one is (accepted here or in another tab).
      if ((!hadController && !updateAccepted) || reloading) return;
      reloading = true;
      location.reload();
    };
    sw.addEventListener('controllerchange', onController);
    void sw
      .register(workerScriptUrl(), { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        const track = (w: ServiceWorker | null) => {
          if (!w) return;
          const check = () => {
            if (w.state === 'installed' && sw.controller) setWaiting(w);
          };
          w.addEventListener('statechange', check);
          check();
        };
        track(reg.waiting);
        reg.addEventListener('updatefound', () => track(reg.installing));
      })
      .catch(() => undefined);
    return () => sw.removeEventListener('controllerchange', onController);
  }, []);

  // The signed-in user, for the worker's user-scoped caches.
  useEffect(() => {
    if (userId === undefined || !swEnabled()) return;
    postToWorker({ type: 'cp:session', userId, locale });
  }, [userId, locale]);

  // Client-side moves inside the offline sections (the garage opening a car, an appointment): the worker keeps a
  // copy of that page's document too, so a reload offline finds it.
  const pathname = usePathname();
  useEffect(() => {
    if (!userId || !online || !swEnabled() || !pathname) return;
    const section = pathname.split('/')[2];
    if (section && OFFLINE_SECTIONS.has(section)) postToWorker({ type: 'cp:keep', url: `${pathname}${location.search}` });
  }, [pathname, userId, online]);

  // A push subscription of another account (or of a signed-out session) does not stay on this browser.
  useEffect(() => {
    if (userId === undefined || typeof window === 'undefined' || !('localStorage' in window)) return;
    const env = browserPushEnv(APP_VERSION);
    const record = env.read();
    if (record && record.userId !== userId)
      void unsubscribePush(null, env)
        .catch(() => undefined)
        .finally(notifyPushChanged);
  }, [userId]);

  // Sign-out steps.
  useEffect(() => {
    const offBefore = addLogoutStep('before', async () => {
      const env = browserPushEnv(APP_VERSION);
      if (env.read()) await unsubscribePush(api, env);
      notifyPushChanged();
    });
    const offAfter = addLogoutStep('after', clearPrivateCaches);
    return () => {
      offBefore();
      offAfter();
    };
  }, [api]);

  return (
    <>
      {!online ? (
        <div className="pwa-offline-bar" role="status" data-testid="offline-bar">
          <Icon name="offline" size={20} />
          <span>{t('pwa.offline.bar')}</span>
          <a className="pwa-link" href={`/${locale}/offline`}>
            {t('pwa.offline.saved')}
          </a>
        </div>
      ) : null}
      {waiting ? (
        <div className="pwa-update-bar" role="status" data-testid="update-bar">
          <span>{t('pwa.update.text')}</span>
          <Button
            size="sm"
            variant="primary"
            icon="refresh"
            onClick={() => {
              updateAccepted = true;
              waiting.postMessage({ type: 'cp:skip-waiting' } satisfies PageMessage);
              setWaiting(null);
            }}
          >
            {t('pwa.update.reload')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
