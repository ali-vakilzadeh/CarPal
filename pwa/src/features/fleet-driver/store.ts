'use client';
// Drafts and the offline queue of driver reports in this browser (model.ts rules), and the sync that sends queued
// reports once the network is back. Kept per user; the private-cache wipe of a sign-out does not touch it, so the
// sign-out removes it explicitly (features/fleet-driver registers a logout step).
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { addLogoutStep } from '@/lib/api/session';
import { parseMileage } from '@/features/garage';
import { EMPTY_STORE, parseStore, reportTitle, storeKey, withoutQueued, type DriverStore, type ReportDraft } from './model';

const EVENT = 'cp:drive-store';
const cache = new Map<string, { raw: string | null; value: DriverStore }>();

function read(userId: string): DriverStore {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storeKey(userId));
  } catch {
    raw = null;
  }
  const hit = cache.get(userId);
  if (hit && hit.raw === raw) return hit.value;
  const value = raw ? parseStore(raw) : EMPTY_STORE;
  cache.set(userId, { raw, value });
  return value;
}

export function writeDriverStore(userId: string, next: DriverStore): void {
  try {
    if (Object.keys(next.drafts).length === 0 && next.queue.length === 0) localStorage.removeItem(storeKey(userId));
    else localStorage.setItem(storeKey(userId), JSON.stringify(next));
  } catch {
    // storage blocked: drafts live only in the form
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useDriverStore(userId: string | null): [DriverStore, (update: (s: DriverStore) => DriverStore) => void] {
  const value = useSyncExternalStore(
    (l) => {
      window.addEventListener(EVENT, l);
      window.addEventListener('storage', l);
      return () => {
        window.removeEventListener(EVENT, l);
        window.removeEventListener('storage', l);
      };
    },
    () => (userId ? read(userId) : EMPTY_STORE),
    () => EMPTY_STORE,
  );
  const update = useCallback(
    (fn: (s: DriverStore) => DriverStore) => {
      if (userId) writeDriverStore(userId, fn(read(userId)));
    },
    [userId],
  );
  return [value, update];
}

/** Sends one report: the issue (fleet route), then the odometer reading when one was typed. */
export async function sendReport(
  api: ApiClient,
  d: ReportDraft,
  o: { title: string | null; locale: string; mediaIds?: string[] },
): Promise<{ issueId: string; mileageFailed: boolean }> {
  const path = { org_id: d.orgId, vehicle_id: d.vehicleId };
  const issue = await api.api('issues.create', {
    path,
    body: {
      title: reportTitle(d.description, o.title).slice(0, 120),
      description: d.description.trim().slice(0, 3000),
      content_locale: o.locale === 'en' ? 'en' : 'fa',
      urgency_level: d.urgency,
      ...(o.mediaIds?.length ? { media_ids: o.mediaIds.slice(0, 10) } : {}),
    },
  });
  let mileageFailed = false;
  const km = d.mileage.trim() ? parseMileage(d.mileage) : null;
  if (km !== null) {
    await api.api('vehicles.mileage_add', { path, body: { mileage_km: km, recorded_at: new Date().toISOString() } }).catch(() => {
      mileageFailed = true;
    });
  }
  return { issueId: issue.id, mileageFailed };
}

export const isNetworkProblem = (err: unknown) => err instanceof ApiProblem && err.code === 'NETWORK';

/**
 * Sends queued reports while online (on mount and on every 'online' event). A network failure stops the round; any
 * other refusal drops that report (it would never pass) and reports it through onDropped.
 */
export function useQueueSync(
  api: ApiClient,
  userId: string | null,
  o: { locale: string; titleOf: (d: ReportDraft) => string | null; onSent: (n: number) => void; onDropped: (n: number) => void },
) {
  const { locale, titleOf, onSent, onDropped } = o;
  useEffect(() => {
    if (!userId) return;
    let running = false;
    const run = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      let sent = 0;
      let dropped = 0;
      try {
        for (const d of read(userId).queue) {
          try {
            await sendReport(api, d, { title: titleOf(d), locale });
            sent++;
          } catch (err) {
            if (isNetworkProblem(err)) break;
            dropped++;
          }
          writeDriverStore(userId, withoutQueued(read(userId), d.id));
        }
      } finally {
        running = false;
        if (sent) onSent(sent);
        if (dropped) onDropped(dropped);
      }
    };
    void run();
    window.addEventListener('online', run);
    return () => window.removeEventListener('online', run);
  }, [api, userId, locale, titleOf, onSent, onDropped]);
}

/** A sign-out removes this browser's drafts and queue of every user (they may hold location or plate details). */
if (typeof window !== 'undefined')
  addLogoutStep('after', async () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('cp:drive:')) localStorage.removeItem(k);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(EVENT));
  });
