'use client';
// The staff avatar menu of the top bar (AC4.T3, Docs/23 §3.1): who is signed in and with which roles, "My actions"
// (the audit log filtered to the caller; only for roles that may read the audit log, GD-08/GD-09), language, theme
// and sign out. A disclosure (button + panel), not an ARIA menu: its items are ordinary links and one button. Esc and
// a click outside close it.
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar } from '@/components/ds/avatar';
import { Icon } from '@/components/ds/icon';
import type { StaffRole } from '@/lib/api/generated';
import { useLocale, useT } from '@/lib/i18n/client';
import { LOCALES } from '@/lib/i18n/locales';
import { prefHref } from '@/lib/prefs';
import { canCall } from '@/lib/roles';
import { THEME_CHOICES } from '@/lib/theme';
import { roleNames } from './roles';
import { useSignOut } from './session-watch';

export function AccountMenu({ name, roles, themeChoice }: { name: string; roles: readonly StaffRole[]; themeChoice: string }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const here = `${pathname}${search.size ? `?${search.toString()}` : ''}`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div className="adm-account" ref={root}>
      <button
        ref={button}
        type="button"
        className="adm-account-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={name} size={32} />
        <span className="adm-account-name">{name}</span>
        <span className="sr-only">{t('admin.shell.account.menu')}</span>
        <Icon name="down" size={16} />
      </button>
      <div id={panelId} className="adm-account-panel" hidden={!open}>
        <p className="adm-account-who">
          <strong>{name}</strong>
          <span className="adm-muted">{t('admin.shell.account.roles', { roles: roleNames(roles, t) })}</span>
        </p>
        <ul className="adm-account-list">
          {canCall('admin.audit_search', roles) ? (
            <li>
              <Link href="/audit?actor=me">{t('admin.shell.account.myActions')}</Link>
            </li>
          ) : null}
        </ul>
        <p className="adm-account-heading" id={`${panelId}-lang`}>
          {t('admin.prefs.language')}
        </p>
        <ul className="adm-account-choices" aria-labelledby={`${panelId}-lang`}>
          {LOCALES.map((l) => (
            <li key={l}>
              <a href={prefHref(here, 'lang', l)} lang={l} aria-current={l === locale ? 'true' : undefined}>
                {t(`common.language.${l}`)}
              </a>
            </li>
          ))}
        </ul>
        <p className="adm-account-heading" id={`${panelId}-theme`}>
          {t('admin.prefs.theme')}
        </p>
        <ul className="adm-account-choices" aria-labelledby={`${panelId}-theme`}>
          {THEME_CHOICES.map((c) => (
            <li key={c}>
              <a href={prefHref(here, 'theme', c)} aria-current={c === themeChoice ? 'true' : undefined}>
                {t(`common.theme.${c}`)}
              </a>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="cp-btn cp-btn-secondary cp-btn-sm cp-btn-block"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            signOut();
          }}
        >
          <Icon name="logout" size={20} />
          <span className="cp-btn-label">{t('admin.shell.account.signOut')}</span>
        </button>
      </div>
    </div>
  );
}
