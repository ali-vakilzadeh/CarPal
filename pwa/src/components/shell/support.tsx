'use client';
// "Contact support" (OQ-18, P13.T8): for the MVP an email to the deployment's support address (CARPAL_PWA_SUPPORT_EMAIL,
// default support@carpals.ir). Offered by the footer, the timed sign-in lock (S-AUTH-09) and
// Settings → Help (C-PROF-09: Contact support, Report a problem with the app version).
import type { ReactNode } from 'react';
import { usePwaConfig } from '@/lib/config/client';

/** mailto: with an optional subject and body (encoded per RFC 6068). */
export function supportHref(email: string, o: { subject?: string; body?: string } = {}): string {
  const q = [o.subject ? `subject=${encodeURIComponent(o.subject)}` : '', o.body ? `body=${encodeURIComponent(o.body)}` : '']
    .filter(Boolean)
    .join('&');
  return `mailto:${email}${q ? `?${q}` : ''}`;
}

export function SupportLink({
  subject,
  body,
  className = 'pwa-link',
  children,
}: {
  subject?: string;
  body?: string;
  className?: string;
  children: ReactNode;
}) {
  const { supportEmail } = usePwaConfig();
  return (
    <a className={className} href={supportHref(supportEmail, { subject, body })}>
      {children}
    </a>
  );
}

export function useSupportEmail(): string {
  return usePwaConfig().supportEmail;
}
