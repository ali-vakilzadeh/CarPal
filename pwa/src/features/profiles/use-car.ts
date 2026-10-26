'use client';
// The visitor's car for the public pages: the signed-in user's active vehicle (per browser, DI-27) as taxonomy names
// in the UI language, because public reads label capabilities and fitment with names, not node ids. Guests have no
// car here (P6 adds the guest vehicle filter of the search page); the pages then show everything.
import { useMemo } from 'react';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import type { VehicleNames } from './view-model';

export function useCarNames(): { car: (VehicleNames & { id: string; year: number | null; label: string }) | null; loading: boolean } {
  const { active, isLoading } = useActiveVehicle();
  const brands = useTaxonomyNodes('vehicle_brand', null, !!active);
  const models = useTaxonomyNodes('vehicle_model', active?.brand_node_id ?? null, !!active?.brand_node_id);
  const series = useTaxonomyNodes('vehicle_series', active?.model_node_id ?? null, !!active?.model_node_id);
  return useMemo(() => {
    if (!active) return { car: null, loading: isLoading };
    const brand = brands.data?.find((n) => n.id === active.brand_node_id)?.name.text;
    if (!brand) return { car: null, loading: brands.isPending };
    const model = models.data?.find((n) => n.id === active.model_node_id)?.name.text ?? null;
    const s = series.data?.find((n) => n.id === active.series_node_id)?.name.text ?? null;
    return {
      car: { id: active.id, brand, model, series: s, year: active.year ?? null, label: [brand, model, s].filter(Boolean).join(' ') },
      loading: false,
    };
  }, [active, isLoading, brands.data, brands.isPending, models.data, series.data]);
}
