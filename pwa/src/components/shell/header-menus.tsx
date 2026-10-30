'use client';
// Signed-in header controls (Docs/22 §2.2): the notifications bell with the unread count (max "99+") and its
// dropdown panel (W-NOTIF-01, features/notifications since P9), and the avatar menu (Profile, My activity, Saved,
// Settings, Switch account, Log out, plus language and theme). The menu is a disclosure (button + panel of links),
// closed by Esc, a click outside or choosing an item.
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar } from '@/components/ds/avatar';
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';
import { useLogout, type SessionView } from '@/lib/api/session';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { LanguageSwitch, ThemePicker } from './preferences';
import { useToast } from './toast';
import { useLoginHref } from './use-login-href';

// The bell and its dropdown live with the notifications feature (W-NOTIF-01, P9.T1).
export { NotificationsBell, unreadBadge, UNREAD_POLL_MS } from '@/features/notifications';

const MENU: { key: MessageKey; path: string; icon: IconName }[] = [
  { key: 'shell.menu.profile', path: '/settings/profile', icon: 'user' },
  { key: 'shell.menu.activity', path: '/activity', icon: 'list' },
  { key: 'shell.menu.saved', path: '/saved', icon: 'bookmark' },
  { key: 'shell.menu.settings', path: '/settings', icon: 'sliders' },
];

export function AccountMenu({ user }: { user: NonNullable<SessionView['user']> }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const logout = useLogout();
  // "Switch account" asks for credentials again (prompt=login) instead of reusing the auth host's sign-in (P4).
  const switchHref = useLoginHref(undefined, { switchAccount: true });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const name = user.display_name || t('shell.header.accountMenu');
  return (
    <div className="pwa-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="cp-iconbtn pwa-avatar-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Named by its hidden text, not aria-label: the visible initials are decorative, and an aria-label that does
            not contain them fails WCAG 2.5.3 label-in-name (axe label-content-name-mismatch, found in P7). */}
        <span className="sr-only">{t('shell.header.accountMenu')}</span>
        <span aria-hidden="true">
          <Avatar name={name} size={32} />
        </span>
      </button>
      <div id={panelId} className={cx('pwa-menu-panel', !open && 'is-hidden')}>
        <p className="pwa-menu-heading">
          {t('shell.menu.signedInAs')} <bdi>{name}</bdi>
        </p>
        <nav aria-label={t('shell.header.accountMenu')}>
          <ul className="pwa-menu-list">
            {MENU.map((m) => (
              <li key={m.key}>
                <Link href={`/${locale}${m.path}`} className="pwa-menu-item" onClick={() => setOpen(false)}>
                  <Icon name={m.icon} size={20} />
                  <span>{t(m.key)}</span>
                </Link>
              </li>
            ))}
            <li>
              <a href={switchHref} className="pwa-menu-item">
                <Icon name="user" size={20} />
                <span>{t('shell.menu.switchAccount')}</span>
              </a>
            </li>
            <li>
              <button
                type="button"
                className="pwa-menu-item"
                onClick={async () => {
                  setOpen(false);
                  await logout();
                  toast(t('shell.menu.loggedOut'));
                }}
              >
                <Icon name="logout" size={20} />
                <span>{t('shell.menu.logOut')}</span>
              </button>
            </li>
          </ul>
        </nav>
        <div className="pwa-menu-section">
          <LanguageSwitch variant="secondary" />
        </div>
        <div className="pwa-menu-section">
          <ThemePicker />
        </div>
      </div>
    </div>
  );
}
