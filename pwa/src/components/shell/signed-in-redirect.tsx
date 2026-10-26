'use client';
// Signed-in visitors of a guest page (the landing page) go to `to` (P4.T7). The server redirects when it sees the
// session cookie; this covers cross-site arrivals, where SameSite=Strict withholds the cookie from the first request.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/api/session';

export function SignedInRedirect({ to }: { to: string }) {
  const router = useRouter();
  const signedIn = useSession().data?.signed_in === true;
  useEffect(() => {
    if (signedIn) router.replace(to);
  }, [signedIn, router, to]);
  return null;
}
