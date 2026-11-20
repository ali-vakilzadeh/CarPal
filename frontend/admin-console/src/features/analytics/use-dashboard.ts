'use client';
// One KPI dashboard for a period (admin.analytics_dashboard; ADM, MOD, SUP; aggregates only). The query key is the
// operation's, so the home dashboard's widgets, the analytics page and the AI overview share the answers. While a new
// period loads, the last answer stays on screen (charts hold their drawing, dataviz "refetch keeps the frame").
import { keepPreviousData } from '@tanstack/react-query';
import type { DashboardKey } from '@carpal/api-contracts';
import { useApiQuery } from '@/lib/api/query';
import type { DayRange } from './analytics-logic';

export function useDashboard(key: DashboardKey, range: DayRange, o: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useApiQuery(
    'admin.analytics_dashboard',
    { path: { dashboard_key: key }, query: { from: range.from, to: range.to } },
    {
      enabled: o.enabled ?? true,
      staleTime: 60_000,
      placeholderData: keepPreviousData,
      ...(o.refetchInterval ? { refetchInterval: o.refetchInterval } : {}),
    },
  );
}
