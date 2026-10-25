'use client';
// Modal with a URL (Docs/22 §2.5 "short tasks use modals with a URL that can be refreshed"): a modal is open while
// ?modal=<name> is in the address. Opening pushes a history entry, so Back closes it; a refresh or a shared link
// opens it again. Closing goes back when this page opened it, otherwise it replaces the URL without the parameter.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { Dialog, type DialogProps } from './dialog';

export const MODAL_PARAM = 'modal';

/** Names of modals this page instance opened itself (so Back is the right way to close them). */
const openedHere = new Set<string>();

export function modalHref(pathname: string, search: URLSearchParams, name: string | null, params: Record<string, string> = {}): string {
  const next = new URLSearchParams(search);
  next.delete(MODAL_PARAM);
  for (const key of Object.keys(params)) next.delete(key);
  if (name) {
    next.set(MODAL_PARAM, name);
    for (const [k, v] of Object.entries(params)) next.set(k, v);
  }
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export interface UrlModalControl {
  isOpen: boolean;
  open: (params?: Record<string, string>) => void;
  close: () => void;
  /** Extra parameters the modal was opened with (e.g. a report target). */
  params: URLSearchParams;
}

export function useUrlModal(name: string, paramKeys: readonly string[] = []): UrlModalControl {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const isOpen = search.get(MODAL_PARAM) === name;

  const open = useCallback(
    (params: Record<string, string> = {}) => {
      openedHere.add(name);
      router.push(modalHref(pathname, new URLSearchParams(search.toString()), name, params), { scroll: false });
    },
    [router, pathname, search, name],
  );

  const close = useCallback(() => {
    if (openedHere.delete(name)) router.back();
    else {
      const cleared = Object.fromEntries(paramKeys.map((k) => [k, '']));
      router.replace(modalHref(pathname, new URLSearchParams(search.toString()), null, cleared), { scroll: false });
    }
  }, [router, pathname, search, name, paramKeys]);

  return useMemo(() => ({ isOpen, open, close, params: search }), [isOpen, open, close, search]);
}

/** A Dialog driven by ?modal=<name>. */
export function UrlModal({ control, ...props }: Omit<DialogProps, 'open' | 'onClose'> & { control: UrlModalControl }) {
  return <Dialog {...props} open={control.isOpen} onClose={control.close} />;
}
