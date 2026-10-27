'use client';
// Names for ids (vehicles carry taxonomy node ids only): "BMW 3 Series · 2008", service categories and tasks.
import type { TaxonomyNode, TaxonomyType, Vehicle, VehicleTransfer } from '@carpal/api-contracts';
import { useMemo } from 'react';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';

export function nameOf(nodes: readonly TaxonomyNode[] | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  return nodes?.find((n) => n.id === id)?.name.text ?? null;
}

export function useNodeNames(type: TaxonomyType, parentId: string | null = null, enabled = true) {
  const q = useTaxonomyNodes(type, parentId, enabled);
  return useMemo(
    () => ({ nodes: q.data ?? [], name: (id: string | null | undefined) => nameOf(q.data, id), loading: q.isPending }),
    [q.data, q.isPending],
  );
}

type ModelRef = Pick<Vehicle, 'brand_node_id' | 'model_node_id' | 'year'> & { series_node_id?: string };

/** "BMW 320i" and "BMW 320i · E90 · 2008" for a vehicle or a transfer's vehicle summary. */
export function useModelName(v: ModelRef | VehicleTransfer['vehicle_summary'] | null) {
  const f = useFormat();
  const brands = useNodeNames('vehicle_brand', null, !!v);
  const models = useNodeNames('vehicle_model', v?.brand_node_id ?? null, !!v);
  const seriesId = v && 'series_node_id' in v ? v.series_node_id : undefined;
  const series = useNodeNames('vehicle_series', seriesId ? v!.model_node_id : null, !!seriesId);
  if (!v) return { model: '', full: '' };
  const model = [brands.name(v.brand_node_id), models.name(v.model_node_id)].filter(Boolean).join(' ');
  const full = [model, series.name(seriesId), f.digits(v.year)].filter(Boolean).join(' · ');
  return { model, full };
}

/** Nickname, else the model name (list cards, headings). */
export function useVehicleTitle(v: Vehicle | null): string {
  const { model } = useModelName(v);
  return v?.nickname || model;
}
