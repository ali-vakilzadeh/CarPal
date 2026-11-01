'use client';
// W-SET-01 Help (mirrors C-PROF-09; P9): how CarPal ranks shops, reporting content (the Report button on every public
// page) and the app version. P13 (OQ-18): Contact support and Report a problem are emails to the deployment's support
// address (the problem report names the app version and the page language; the user writes the rest), and the
// Privacy Policy and User Agreement are linked. Help articles have no source yet and stay out.
import Link from 'next/link';
import { Icon } from '@/components/ds/icon';
import { SupportLink, useSupportEmail } from '@/components/shell/support';
import { useLocale, useT } from '@/lib/i18n/client';
import { Card } from './parts';

export function HelpSection({ appVersion }: { appVersion: string }) {
  const t = useT();
  const locale = useLocale();
  const email = useSupportEmail();
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
      <Card title={t('settings.help.contactTitle')}>
        <ul className="pwa-settings-list">
          <li>
            <SupportLink className="pwa-row-link" subject={t('settings.help.supportSubject')}>
              <Icon name="send" size={20} />
              <span>{t('shell.support.contact')}</span>
            </SupportLink>
          </li>
          <li>
            <SupportLink
              className="pwa-row-link"
              subject={t('settings.help.problemSubject')}
              body={t('settings.help.problemBody', { version: appVersion, locale })}
            >
              <Icon name="flag" size={20} />
              <span>{t('settings.help.problem')}</span>
            </SupportLink>
          </li>
        </ul>
        <p className="pwa-text-caption m-0">
          {t('settings.help.contactNote')} <bdi dir="ltr">{email}</bdi>
        </p>
      </Card>
      <Card title={t('settings.help.legalTitle')}>
        <ul className="pwa-settings-list">
          <li>
            <a href={`/${locale}/privacy`} className="pwa-row-link">
              <Icon name="lock" size={20} />
              <span>{t('shell.legal.privacy')}</span>
            </a>
          </li>
          <li>
            <a href={`/${locale}/terms`} className="pwa-row-link">
              <Icon name="doc" size={20} />
              <span>{t('shell.legal.terms')}</span>
            </a>
          </li>
        </ul>
      </Card>
      <p className="pwa-text-caption">{t('settings.help.version', { version: appVersion })}</p>
    </div>
  );
}
