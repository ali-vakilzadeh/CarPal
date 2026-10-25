'use client';
// /bff/login link back to the current page, computed from the router (not `location`), so the server-rendered href
// equals the hydrated one.
import { usePathname, useSearchParams } from 'next/navigation';
import { loginUrl } from '@/lib/api/session';
import { useLocale } from '@/lib/i18n/client';

export function useLoginHref(screen?: 'signup'): string {
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return loginUrl({ returnTo: `${pathname}${search ? `?${search}` : ''}`, locale, ...(screen ? { screen } : {}) });
}
