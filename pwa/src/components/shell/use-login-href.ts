'use client';
// /bff/login link back to the current page, computed from the router (not `location`), so the server-rendered href
// equals the hydrated one. A previous sign-in outcome (?signin=…) is not carried back.
import { usePathname, useSearchParams } from 'next/navigation';
import { loginUrl } from '@/lib/api/session';
import { useLocale } from '@/lib/i18n/client';

export function useLoginHref(screen?: 'signup', o: { switchAccount?: boolean } = {}): string {
  const locale = useLocale();
  const pathname = usePathname();
  const params = new URLSearchParams(useSearchParams().toString());
  params.delete('signin');
  const search = params.toString();
  return loginUrl({
    returnTo: `${pathname}${search ? `?${search}` : ''}`,
    locale,
    ...(screen ? { screen } : {}),
    ...(o.switchAccount ? { switchAccount: true } : {}),
  });
}
