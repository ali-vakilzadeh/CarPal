'use client';
// W-SET-01 Settings (mirrors C-PROF-01..04, 07..09; P9.T2-T4) at /<locale>/settings/<section>: the left sub-navigation
// (Profile · Sign-in & security · Privacy & consent · AI preferences · Notifications · Language & region · Data &
// account · Help) and the section beside it; below 768 px the navigation sits above the section as a scrollable row.
// Every section reads and writes through the typed client; AAL2 actions go through the step-up (components/shell).
import Link from 'next/link';
import { Icon, type IconName } from '@/components/ds/icon';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { AiSection } from './ai-section';
import { DataSection } from './data-section';
import { HelpSection } from './help-section';
import { LanguageSection } from './language-section';
import { SECTIONS, type Section } from './model';
import { NotificationsSection } from './notifications-section';
import { PrivacySection } from './privacy-section';
import { ProfileSection } from './profile-section';
import { SecuritySection } from './security-section';

const NAV: Record<Section, { label: MessageKey; icon: IconName }> = {
  profile: { label: 'settings.nav.profile', icon: 'user' },
  security: { label: 'settings.nav.security', icon: 'lock' },
  privacy: { label: 'settings.nav.privacy', icon: 'shield' },
  ai: { label: 'settings.nav.ai', icon: 'spark' },
  notifications: { label: 'settings.nav.notifications', icon: 'bell' },
  language: { label: 'settings.nav.language', icon: 'globe' },
  data: { label: 'settings.nav.data', icon: 'download' },
  help: { label: 'settings.nav.help', icon: 'help' },
};

export interface SettingsScreenProps {
  section: Section;
  /** Privacy policy version recorded with new consents (CARPAL_PWA_PRIVACY_VERSION, DI-30). */
  policyVersion: string;
  appVersion: string;
}

export function SettingsScreen({ section, policyVersion, appVersion }: SettingsScreenProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="pwa-settings">
      <h1 className="pwa-text-title m-0">{t('shell.nav.settings')}</h1>
      <div className="pwa-settings-layout">
        <nav className="pwa-settings-nav" aria-label={t('settings.nav.label')}>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s}>
                <Link
                  href={`/${locale}/settings/${s}`}
                  className={s === section ? 'pwa-settings-link is-current' : 'pwa-settings-link'}
                  aria-current={s === section ? 'page' : undefined}
                >
                  <Icon name={NAV[s].icon} size={20} />
                  <span>{t(NAV[s].label)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="pwa-settings-section" aria-labelledby="settings-section-title">
          <h2 id="settings-section-title" className="pwa-section-title">
            {t(NAV[section].label)}
          </h2>
          {section === 'profile' ? <ProfileSection /> : null}
          {section === 'security' ? <SecuritySection /> : null}
          {section === 'privacy' ? <PrivacySection policyVersion={policyVersion} /> : null}
          {section === 'ai' ? <AiSection policyVersion={policyVersion} /> : null}
          {section === 'notifications' ? <NotificationsSection /> : null}
          {section === 'language' ? <LanguageSection /> : null}
          {section === 'data' ? <DataSection /> : null}
          {section === 'help' ? <HelpSection appVersion={appVersion} /> : null}
        </section>
      </div>
    </div>
  );
}
