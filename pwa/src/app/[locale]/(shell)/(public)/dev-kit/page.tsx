// Dev kit — test/demo page of the P3 shell patterns (CARPAL_PWA_DEMO=1 only; a 404 everywhere else, refused in prod).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DevKit } from '@/features/dev-kit';
import { serverEnv } from '@/server/env';

export const metadata: Metadata = { title: 'Dev kit', robots: { index: false } };

export default function DevKitPage() {
  if (!serverEnv().CARPAL_PWA_DEMO) notFound();
  return <DevKit />;
}
