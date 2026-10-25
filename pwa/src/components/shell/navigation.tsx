'use client';
// Navigation of the shell (Docs/22 §2.1-2.3, Docs/21 §2.1): the left navigation for signed-in users (labels on
// desktop ≥ 1200 px, icons only on tablets 768-1199 px, with the "Your garage" box on desktop), the bottom tab bar on
// phones < 768 px for signed-in users, and the guest menu drawer on phones.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { TabBar } from '@/components/ds/tab-bar';
import { useLocale, useT } from '@/lib/i18n/client';
import { Dialog } from './dialog';
import { activeItem, GUEST_NAV, LEFT_NAV, TABS } from './nav-items';
import { LanguageSwitch, ThemePicker } from './preferences';
import { useLoginHref } from './use-login-href';
import { GarageBox } from './vehicle-context';

export function LeftNav() {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const current = activeItem(LEFT_NAV, pathname);
  return (
    <aside className="pwa-leftnav">
      <nav aria-label={t('shell.nav.label')}>
        <ul className="pwa-leftnav-list">
          {LEFT_NAV.map((item) => {
            const on = item.id === current;
            return (
              <li key={item.id}>
                <Link
                  href={`/${locale}${item.path}`}
                  className={cx('pwa-leftnav-item', on && 'is-active')}
                  aria-current={on ? 'page' : undefined}
                  title={t(item.label)}
                >
                  <Icon name={item.icon} filled={on && item.icon !== 'search'} />
                  <span className="pwa-leftnav-label">{t(item.label)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="pwa-leftnav-garage">
        <GarageBox />
      </div>
    </aside>
  );
}

export function BottomTabs() {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const current = activeItem(TABS, pathname) ?? '';
  return (
    <TabBar
      className="pwa-bottom-tabs"
      label={t('shell.nav.label')}
      active={current}
      linkAs={Link}
      items={TABS.map((it) => ({ id: it.id, label: t(it.label), icon: it.icon, href: `/${locale}${it.path}`, primary: it.id === 'help' }))}
    />
  );
}

export function GuestMenu() {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = activeItem(GUEST_NAV, pathname);
  const loginHref = useLoginHref();
  const signupHref = useLoginHref('signup');
  return (
    <>
      <IconButton
        icon="list"
        label={t('shell.header.openMenu')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="pwa-guest-menu-button"
      />
      <Dialog name="guest-menu" open={open} onClose={() => setOpen(false)} title={t('shell.header.menu')} variant="drawer">
        <nav aria-label={t('shell.nav.label')}>
          <ul className="pwa-leftnav-list">
            {GUEST_NAV.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/${locale}${item.path}`}
                  className={cx('pwa-leftnav-item', item.id === current && 'is-active')}
                  aria-current={item.id === current ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <Icon name={item.icon} />
                  <span className="pwa-leftnav-label">{t(item.label)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="pwa-menu-section pwa-menu-actions">
          <a href={loginHref} className={buttonClass({ variant: 'primary', block: true })}>
            <span className="cp-btn-label">{t('shell.header.logIn')}</span>
          </a>
          <a href={signupHref} className={buttonClass({ block: true })}>
            <span className="cp-btn-label">{t('shell.header.signUp')}</span>
          </a>
        </div>
        <div className="pwa-menu-section">
          <LanguageSwitch variant="secondary" />
        </div>
        <div className="pwa-menu-section">
          <ThemePicker />
        </div>
      </Dialog>
    </>
  );
}
