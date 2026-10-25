'use client';
// The active vehicle (Docs/21 principle 1, Docs/22 §2.2-2.3): the vehicle context chip in the search box and the
// "Your garage" box. The contract has no primary/active vehicle field (DI-27), so the choice is kept per browser
// (localStorage) and defaults to the first vehicle in use; "Any vehicle" is a valid choice. Names come from the
// taxonomy (the vehicle carries node ids only): "Silver · BMW 320i".
import type { Vehicle } from '@carpal/api-contracts';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useT } from '@/lib/i18n/client';

export const ACTIVE_VEHICLE_KEY = 'cp:active-vehicle';
/** Stored when the user picked "Any vehicle". */
export const ANY_VEHICLE = 'any';

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === ACTIVE_VEHICLE_KEY && fn();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
function readStored(): string | null {
  try {
    return localStorage.getItem(ACTIVE_VEHICLE_KEY);
  } catch {
    return null;
  }
}

/** Vehicles that count as in use for the context chip. */
export function inUse(v: Vehicle): boolean {
  return v.status === 'active' || v.status === 'in_repair';
}

export function pickActive(vehicles: readonly Vehicle[], stored: string | null): Vehicle | null {
  if (stored === ANY_VEHICLE) return null;
  const usable = vehicles.filter(inUse);
  return usable.find((v) => v.id === stored) ?? usable[0] ?? null;
}

export function useVehicles() {
  const session = useSession();
  return useApiQuery('vehicles.list', { query: { limit: 50 } }, { enabled: session.data?.signed_in === true, staleTime: 60_000 });
}

export function useActiveVehicle() {
  const vehicles = useVehicles();
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const list = useMemo(() => (vehicles.data?.items ?? []).filter(inUse), [vehicles.data]);
  const active = useMemo(() => pickActive(list, stored), [list, stored]);
  const setActive = useCallback((id: string) => {
    try {
      localStorage.setItem(ACTIVE_VEHICLE_KEY, id);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
    for (const fn of listeners) fn();
  }, []);
  return { vehicles: list, active, setActive, isLoading: vehicles.isPending && vehicles.fetchStatus !== 'idle', error: vehicles.error };
}

/** "Silver · BMW 320i" (nickname · brand model), "BMW 320i" without a nickname. */
export function useVehicleLabel(v: Vehicle | null): string | null {
  const t = useT();
  const brands = useTaxonomyNodes('vehicle_brand', null, !!v);
  const models = useTaxonomyNodes('vehicle_model', v?.brand_node_id ?? null, !!v);
  if (!v) return null;
  const brand = brands.data?.find((n) => n.id === v.brand_node_id)?.name.text;
  const model = models.data?.find((n) => n.id === v.model_node_id)?.name.text;
  const name = [brand, model].filter(Boolean).join(' ');
  if (v.nickname && name) return t('vehicle.label', { nickname: v.nickname, model: name });
  return v.nickname || name || null;
}
