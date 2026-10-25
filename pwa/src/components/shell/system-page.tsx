// W-SYS-01 System pages (P3.T8): not found (404), content removed (410, no reason shown publicly), profile suspended
// (200 + noindex), no access (403 + switch account), maintenance (503 + time estimate). Offline is P12. Standalone
// (no shell, no API calls), so they render even when the backend is down. The status itself is set by whoever
// renders them: notFound()/forbidden() in a page, or the proxy's status rewrite (src/server/system-status.ts).
import type { ReactNode } from 'react';
import { buttonClass } from '@/components/ds/button';
import { Icon, type IconName } from '@/components/ds/icon';
import { typeClass } from '@/lib/design-system';
import { formatDate } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import type { Locale } from '@/lib/i18n/locales';
import type { SystemKind } from '@/lib/system';

export { SYSTEM_KINDS, SYSTEM_STATUS, isSystemKind, type SystemKind } from '@/lib/system';

const CONTENT: Record<SystemKind, { icon: IconName; title: MessageKey; text?: MessageKey; meta: MessageKey }> = {
  'not-found': { icon: 'search', title: 'system.notFound.title', text: 'system.notFound.text', meta: 'system.notFound.metaTitle' },
  gone: { icon: 'trash', title: 'system.gone.title', text: 'system.gone.text', meta: 'system.gone.metaTitle' },
  suspended: { icon: 'store', title: 'system.suspended.title', text: 'system.suspended.text', meta: 'system.suspended.metaTitle' },
  'no-access': { icon: 'lock', title: 'system.noAccess.title', text: 'system.noAccess.text', meta: 'system.noAccess.metaTitle' },
  maintenance: { icon: 'clock', title: 'system.maintenance.title', meta: 'system.maintenance.metaTitle' },
};

export function systemMetaTitle(kind: SystemKind, t: Translate): string {
  return t(CONTENT[kind].meta);
}

export interface SystemPageProps {
  kind: SystemKind;
  locale: Locale;
  t: Translate;
  /** maintenance: expected end (ISO); shown as a time in the UI calendar. */
  until?: string | null;
  timeZone?: string;
  /** Replaces the default actions. */
  actions?: ReactNode;
}

/** "We expect to be back at about 14:30" (with the date when it is more than 20 hours away), or "back shortly". */
export function maintenanceText(
  until: string | null | undefined,
  locale: Locale,
  t: Translate,
  timeZone?: string,
  now = Date.now(),
): string {
  const at = until ? Date.parse(until) : NaN;
  if (Number.isNaN(at)) return t('system.maintenance.soon');
  return t('system.maintenance.until', { time: formatDate(at, locale, at - now > 20 * 3600_000 ? 'dateTime' : 'time', timeZone) });
}

export function SystemPage({ kind, locale, t, until, timeZone, actions }: SystemPageProps) {
  const c = CONTENT[kind];
  const home = `/${locale}`;
  const text = kind === 'maintenance' ? maintenanceText(until, locale, t, timeZone) : c.text ? t(c.text) : null;
  const defaultActions =
    kind === 'maintenance' ? (
      // Reload without JavaScript: a GET form submits to the current address.
      <form method="get">
        <button type="submit" className={buttonClass({ variant: 'primary' })}>
          <Icon name="refresh" size={20} />
          <span className="cp-btn-label">{t('system.actions.reload')}</span>
        </button>
      </form>
    ) : (
      <>
        <a href={home} className={buttonClass({ variant: 'primary' })}>
          <Icon name="home" size={20} />
          <span className="cp-btn-label">{t('system.actions.home')}</span>
        </a>
        {kind === 'no-access' ? (
          <a href={`/bff/login?return_to=${encodeURIComponent(home)}&locale=${locale}`} className={buttonClass({})}>
            <Icon name="user" size={20} />
            <span className="cp-btn-label">{t('system.actions.switchAccount')}</span>
          </a>
        ) : (
          <a href={`${home}#search`} className={buttonClass({})}>
            <Icon name="search" size={20} />
            <span className="cp-btn-label">{kind === 'suspended' ? t('system.actions.findOthers') : t('system.actions.search')}</span>
          </a>
        )}
      </>
    );

  return (
    <div className="pwa-system" data-system={kind}>
      <header>
        <a href={home} className="pwa-system-logo" aria-label={t('shell.header.home')}>
          <span className="pwa-wordmark-sm" lang="en" dir="ltr" aria-hidden="true">
            CarPal
          </span>
        </a>
      </header>
      <main id="main" tabIndex={-1} className="pwa-system-main">
        <span className="pwa-hero-mark" aria-hidden="true">
          <Icon name={c.icon} size={48} />
        </span>
        <h1 className={`${typeClass(locale, 'title')} m-0`}>{t(c.title)}</h1>
        {text ? <p className={`${typeClass(locale, 'body')} m-0`}>{text}</p> : null}
        <div className="pwa-system-actions">{actions ?? defaultActions}</div>
      </main>
    </div>
  );
}
