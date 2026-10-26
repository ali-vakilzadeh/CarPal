'use client';
// taxonomy.suggest for the search page's chip editor ("+ Add" in "Understood as"): the same rules as the header search
// (src/components/shell/search-box.tsx) — debounced, cached per text, paused after a 429 until the server's delay
// passes (the guest search bucket, DI-28).
import type { TaxonomySuggestion, TaxonomyType } from '@carpal/api-contracts';
import { useEffect, useRef, useState } from 'react';
import { SUGGEST_DEBOUNCE_MS, SUGGEST_MIN_CHARS } from '@/components/shell/search-box';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';

export const CHIP_TYPES: TaxonomyType[] = ['service_system', 'service_task', 'symptom', 'part_category', 'vehicle_brand'];

export function useSuggestions(text: string, types: TaxonomyType[] = CHIP_TYPES): TaxonomySuggestion[] {
  const api = useApiClient();
  const [results, setResults] = useState<Record<string, TaxonomySuggestion[]>>({});
  const pausedUntil = useRef(0);
  const q = text.trim();
  const key = q.toLowerCase();
  const wanted = q.length >= SUGGEST_MIN_CHARS;
  const known = wanted && key in results;
  const typesKey = types.join(',');

  useEffect(() => {
    if (!wanted || known || Date.now() < pausedUntil.current) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.api('taxonomy.suggest', {
          body: { text: q, types: typesKey.split(',') as TaxonomyType[] },
          signal: ctrl.signal,
        });
        setResults((r) => ({ ...r, [key]: res.items }));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiProblem && (err.status === 429 || err.code === 'PAUSED'))
          pausedUntil.current = Date.now() + (err.retryAfterMs ?? 60_000);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, key, wanted, known, typesKey, api]);

  return wanted ? (results[key] ?? []) : [];
}
