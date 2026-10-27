'use client';
// Garage data (P7): TanStack queries over the typed client, keyed by operation id so a write can refresh every list
// of its kind. List pages take the contract's maximum of 50 (Docs/40 §4 Page). Writes on list items send If-Match
// from the ETag cache when the item was read on its own, else the item's version in the server's ETag form
// ("v<version>", backend SEC-IC-3); a 412 then means someone changed it meanwhile (GD-09 amendment 5).
import type { OperationId } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useVehicles } from '@/components/shell/active-vehicle';
import { useApiClient, useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';

export const PAGE = 50;

export { useVehicles };

export function useVehicle(vehicleId: string | null) {
  return useApiQuery('vehicles.get', vehicleId ? { path: { vehicle_id: vehicleId } } : undefined, { enabled: !!vehicleId });
}

export function useSubscription() {
  const session = useSession();
  return useApiQuery('subscription.me_get', undefined, { enabled: session.data?.signed_in === true, staleTime: 60_000 });
}

export interface HistoryFilters {
  systemId?: string;
  verifiedOnly?: boolean;
  from?: string;
  to?: string;
}

export function useRecords(vehicleId: string, f: HistoryFilters = {}) {
  return useApiInfiniteQuery('service_records.list', {
    path: { vehicle_id: vehicleId },
    query: {
      limit: PAGE,
      ...(f.systemId ? { service_system_node_id: f.systemId } : {}),
      ...(f.verifiedOnly ? { verification: 'verified' as const } : {}),
      ...(f.from ? { from: f.from } : {}),
      ...(f.to ? { to: f.to } : {}),
    },
  });
}

export function useRecord(vehicleId: string, recordId: string | null) {
  return useApiQuery('service_records.get', recordId ? { path: { vehicle_id: vehicleId, record_id: recordId } } : undefined, {
    enabled: !!recordId,
  });
}

export function useIssues(vehicleId: string) {
  return useApiQuery('issues.list', { path: { vehicle_id: vehicleId }, query: { limit: PAGE } });
}

export function useIssue(vehicleId: string, issueId: string | null) {
  return useApiQuery('issues.get', issueId ? { path: { vehicle_id: vehicleId, issue_id: issueId } } : undefined, { enabled: !!issueId });
}

export function useReminders(vehicleId: string) {
  return useApiQuery('reminders.list', { path: { vehicle_id: vehicleId }, query: { limit: PAGE } });
}

export function useDocuments(vehicleId: string) {
  return useApiQuery('vehicles.documents_list', { path: { vehicle_id: vehicleId }, query: { limit: PAGE } });
}

export function useMileage(vehicleId: string) {
  return useApiQuery('vehicles.mileage_list', { path: { vehicle_id: vehicleId }, query: { limit: 5 } });
}

export function useTransfers() {
  const session = useSession();
  return useApiQuery(
    'vehicles.transfers_list',
    { query: { status: 'pending', limit: PAGE } },
    { enabled: session.data?.signed_in === true },
  );
}

/** Refreshes every cached query of the given operations. */
export function useRefresh() {
  const qc = useQueryClient();
  return useCallback((...ops: OperationId[]) => Promise.all(ops.map((op) => qc.invalidateQueries({ queryKey: [op] }))), [qc]);
}

/** If-Match for an item read from a list: the cached ETag of its own path when known, else "v<version>". */
export function useItemEtag() {
  const api = useApiClient();
  return useCallback((path: string, version: number) => api.etags.get(path) ?? `"v${version}"`, [api]);
}

export const VEHICLE_OPS: OperationId[] = ['vehicles.list', 'vehicles.get', 'subscription.me_get'];
