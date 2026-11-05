'use client';
// Account preferences that change what other screens show (contract 1.2.0).
import { useApiQuery } from './query';
import { useSession } from './session';

/** "Show why I'm seeing a recommendation" (W-SET-01 AI): on for guests and until the account says otherwise. */
export function useShowReasons(): boolean {
  const session = useSession();
  const prefs = useApiQuery('me.preferences_get', undefined, { enabled: !!session.data?.signed_in, staleTime: 300_000 });
  return prefs.data?.ai_show_reasons ?? true;
}
