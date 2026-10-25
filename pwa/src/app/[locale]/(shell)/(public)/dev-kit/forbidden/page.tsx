// Dev kit: forbidden() from a page → the W-SYS-01 "No access" page with status 403 (CARPAL_PWA_DEMO=1 only).
import { forbidden, notFound } from 'next/navigation';
import { serverEnv } from '@/server/env';

export default function DevKitForbidden() {
  if (!serverEnv().CARPAL_PWA_DEMO) notFound();
  forbidden();
}
