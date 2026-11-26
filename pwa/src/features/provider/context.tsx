'use client';
// The business context of CarPal Workshop (PW1.T3): the provider businesses of the signed-in user from
// me.memberships_list and the active one. The active business is the one named in the address (?org=…, used by the
// account menu and notification links), else the one kept on this device (localStorage: an organization id only, no
// API answer, PRV-GD-05; owner answer PRV-OQ-12), else the first. Other tabs follow a switch (storage event). A
// sign-out forgets it. The server still checks every call (PRV-GD-03).
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { addLogoutStep, useSession } from '@/lib/api/session';
import { ACTIVE_KEY_PREFIX, activeKey, pickBusiness, providerBusinesses, type Business } from './model';

const EVENT = 'cp:provider-active';

function readActive(userId: string): string | null {
  try {
    return localStorage.getItem(activeKey(userId));
  } catch {
    return null;
  }
}

function writeActive(userId: string, orgId: string): void {
  try {
    localStorage.setItem(activeKey(userId), orgId);
  } catch {
    // storage blocked: the first business stays active
  }
  window.dispatchEvent(new Event(EVENT));
}

/** This tab's switches (EVENT) and those of the other tabs of this device (storage). */
function subscribe(listener: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(ACTIVE_KEY_PREFIX)) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The provider businesses of the signed-in user (null while unknown). Shares the memberships query of the shell. */
export function useProviderBusinesses(enabled = true) {
  const q = useApiQuery('me.memberships_list', { query: { status: 'active', limit: 50 } }, { staleTime: 5 * 60_000, enabled });
  const businesses = useMemo(() => (q.data ? providerBusinesses(q.data.items) : null), [q.data]);
  return { businesses, isPending: q.isPending, error: q.error, refetch: q.refetch };
}

export interface WorkshopContextValue {
  /** null while loading or after an error. */
  businesses: Business[] | null;
  active: Business | null;
  error: ApiProblem | null;
  retry: () => void;
  select: (orgId: string) => void;
}

const WorkshopContext = createContext<WorkshopContextValue | null>(null);

export function WorkshopProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const userId = session.data?.signed_in ? (session.data.user?.id ?? null) : null;
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const requested = search.get('org');
  const { businesses, error, refetch } = useProviderBusinesses(userId !== null);
  const api = useApiClient();

  // A sign-up that returned straight into the Workshop skipped W-ONB-01, which records the choices made at sign-up
  // (DI-30): record them here. Loaded after render, so the onboarding code stays out of the Workshop's route chunks
  // (PRV-GD-04); nothing is sent unless choices were stored at sign-up.
  useEffect(() => {
    if (!userId) return;
    import('@/features/onboarding')
      .then((m) => m.applySignupChoices(api))
      .catch((err: unknown) => console.warn('sign-up choices not applied', err));
  }, [userId, api]);
  const stored = useSyncExternalStore(
    subscribe,
    () => (userId ? readActive(userId) : null),
    () => null,
  );
  const active = businesses ? pickBusiness(businesses, requested, stored) : null;

  // Keep the business a link asked for, so the other pages of the Workshop stay on it; then take ?org= out of the
  // address, so a later switch in the top bar is not overruled by it.
  useEffect(() => {
    if (!userId || !active) return;
    if (active.orgId !== stored) writeActive(userId, active.orgId);
    if (requested !== null) {
      const rest = new URLSearchParams(search.toString());
      rest.delete('org');
      const q = rest.toString();
      router.replace(`${pathname}${q ? `?${q}` : ''}`);
    }
  }, [userId, active, stored, requested, search, pathname, router]);

  const select = useCallback((orgId: string) => userId && writeActive(userId, orgId), [userId]);
  const retry = useCallback(() => void refetch(), [refetch]);
  const value = useMemo<WorkshopContextValue>(
    () => ({ businesses, active, error: businesses ? null : error, retry, select: (id) => void select(id) }),
    [businesses, active, error, retry, select],
  );
  return <WorkshopContext.Provider value={value}>{children}</WorkshopContext.Provider>;
}

export function useWorkshop(): WorkshopContextValue {
  const v = useContext(WorkshopContext);
  if (!v) throw new Error('useWorkshop outside <WorkshopProvider>');
  return v;
}

/** The active business; only inside the gate, where one exists. */
export function useActiveBusiness(): Business {
  const { active } = useWorkshop();
  if (!active) throw new Error('useActiveBusiness outside <WorkshopGate>');
  return active;
}

/** A sign-out forgets the active business of every user of this device. */
if (typeof window !== 'undefined')
  addLogoutStep('after', async () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(ACTIVE_KEY_PREFIX)) localStorage.removeItem(k);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(EVENT));
  });
