'use client';
// PurposeGate (AC5.T3, GD-10, SEC-ADM-5): private data on the admin plane is read for a work item (a case, dispute,
// privacy request, verification or review approval). The work item travels in the URL as ?purpose=<kind>:<id>; links
// from a work item carry it on (withPurpose), and the client sends it as CarPal-Access-Purpose. A page opened without
// one does not try the read: it asks the staff member to open the record from a work item and lists the queues they
// may open.
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Icon } from '@/components/ds/icon';
import { visibleSections } from '@/features/shell';
import type { AccessPurpose, PurposeKind } from '@/lib/api/client';
import { useSession } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

const PURPOSE = /^(case|dispute|dsr|verification|approval):([0-9a-f-]{36})$/;

/** A valid purpose value, or null (URL values are untrusted). */
export function parsePurpose(value: string | null | undefined): AccessPurpose | null {
  return value && PURPOSE.test(value) ? (value as AccessPurpose) : null;
}

export function purposeKind(purpose: AccessPurpose): PurposeKind {
  return purpose.slice(0, purpose.indexOf(':')) as PurposeKind;
}

/** The page's purpose from ?purpose= (null when missing or malformed). */
export function usePurpose(): AccessPurpose | null {
  return parsePurpose(useSearchParams().get('purpose'));
}

/** A link that keeps the work item: adds (or replaces) ?purpose= on an in-console href. */
export function withPurpose(href: string, purpose: AccessPurpose | null): string {
  if (!purpose) return href;
  const u = new URL(href, 'http://console.invalid');
  u.searchParams.set('purpose', purpose);
  return `${u.pathname}${u.search}${u.hash}`;
}

export interface PurposeGateProps {
  /** A purpose given by the page (e.g. the work item it is); otherwise ?purpose= from the URL. */
  purpose?: AccessPurpose | null;
  children: (purpose: AccessPurpose) => ReactNode;
}

export function PurposeGate({ purpose: given, children }: PurposeGateProps) {
  const fromUrl = usePurpose();
  const purpose = given ?? fromUrl;
  if (purpose) return <>{children(purpose)}</>;
  return <PurposeMissing />;
}

function PurposeMissing() {
  const t = useT();
  const session = useSession();
  const queues = visibleSections(session.data?.staff?.roles ?? []).filter((s) => s.group === 'work' && s.path !== '/');
  return (
    <div className="adm-purpose" data-kit="purpose-missing">
      <Banner tone="info" icon="lock" title={t('admin.kit.purpose.title')} text={t('admin.kit.purpose.text')} />
      {queues.length ? (
        <>
          <p className="adm-muted">{t('admin.kit.purpose.queues')}</p>
          <ul className="adm-tiles">
            {queues.map((s) => (
              <li key={s.id}>
                <Link href={s.path} className="adm-tile">
                  <Icon name={s.icon} size={20} />
                  <span>{t(`admin.shell.nav.${s.id}` as MessageKey)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
