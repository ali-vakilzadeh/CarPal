'use client';
// W-SET-01 Help (mirrors C-PROF-09; P9): how CarPal ranks shops, reporting content (the Report button on every public
// page) and the app version. Help articles, "Report a problem" and "Contact support" have no channel yet (OQ-18): the
// rows are left out until one exists.
import Link from 'next/link';
import { Icon } from '@/components/ds/icon';
import { useLocale, useT } from '@/lib/i18n/client';
import { Card } from './parts';

export function HelpSection({ appVersion }: { appVersion: string }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="pwa-stack">
      <Card title={t('settings.help.topicsTitle')}>
        <ul className="pwa-settings-list">
          <li>
            <Link href={`/${locale}/how-ranking-works`} className="pwa-row-link">
              <Icon name="help" size={20} />
              <span>{t('settings.help.ranking')}</span>
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/questions`} className="pwa-row-link">
              <Icon name="chat" size={20} />
              <span>{t('settings.help.community')}</span>
            </Link>
          </li>
        </ul>
        <p className="pwa-text-caption m-0">{t('settings.help.reportNote')}</p>
      </Card>
      <p className="pwa-text-caption">{t('settings.help.version', { version: appVersion })}</p>
    </div>
  );
}
