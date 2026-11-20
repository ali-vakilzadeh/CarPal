'use client';
// A submitted search in the URL (audit log, MCP access log): its filters, its window and the moment it was sent
// (at=…, so "last 7 days" means the same instants on every render, and pressing Search again searches again).
// Nothing runs before staff press Search (the searches are audited and rate-limited).
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { useFormat } from '@/lib/format/client';
import { instantsOf, windowFromParams, windowParams, type Instants, type SearchWindow } from './search-window';

export function useUrlSearch<K extends string>(keys: readonly K[]) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const f = useFormat();
  const sig = params.toString();
  // A link without at= (written by hand) is read as of when the screen opened.
  const [openedAt] = useState(() => Date.now());
  const state = useMemo(() => {
    const p = new URLSearchParams(sig);
    const window = windowFromParams(p);
    const at = Number(p.get('at'));
    const values = Object.fromEntries(keys.map((k) => [k, p.get(k) ?? ''])) as Record<K, string>;
    const instants: Instants | null = window ? instantsOf(window, Number.isFinite(at) && at > 0 ? at : openedAt, f.timeZone) : null;
    return { window, values, instants, at: Number.isFinite(at) ? at : 0 };
    // keys is a constant list per screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, f.timeZone, openedAt]);

  const submit = useCallback(
    (values: Partial<Record<K, string>>, window: SearchWindow, keep: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(keep)) if (v) p.set(k, v);
      for (const k of keys) {
        const v = values[k]?.trim();
        if (v) p.set(k, v);
      }
      for (const [k, v] of Object.entries(windowParams(window))) p.set(k, v);
      p.set('at', String(Date.now()));
      router.push(`${pathname}?${p.toString()}`, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, pathname],
  );
  return { ...state, submit };
}
