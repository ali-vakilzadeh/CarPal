// Dev kit: notFound() from a page → the W-SYS-01 "Not found" page with status 404 (CARPAL_PWA_DEMO=1 only).
import { notFound } from 'next/navigation';

export default function DevKitMissing() {
  notFound();
}
