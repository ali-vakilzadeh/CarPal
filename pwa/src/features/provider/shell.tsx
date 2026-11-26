'use client';
// The CarPal Workshop shell (PW1.T2, T3, T7; surfaces.workshop_pwa.navigation): a top bar with the business name
// (switch to another business or to the personal app), the business notifications bell and the Workshop menu
// (Open in Web UI, notification settings, language, theme, sign out), and the bottom tab bar Today · Requests ·
// Replies · Photos. The gate below the session gate: no provider business → the compact-onboarding entry; the
// memberships could not be read → an error with Retry. The consumer shell (header, left navigation) is not used here.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StateBlock } from '@carpal/business-ui';
import { Button, buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { TabBar } from '@/components/ds/tab-bar';
import { LanguageSwitch, ThemePicker } from '@/components/shell/preferences';
import { SkeletonList } from '@/components/shell/skeleton';
import { useToast } from '@/components/shell/toast';
import { useLogout, useSession } from '@/lib/api/session';
import { usePwaConfig } from '@/lib/config/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useWorkshop } from './context';
import { portalHref, workshopPath, workshopTabOf, type Business, type WorkshopTab } from './model';
import { WorkshopBell } from './notifications';

/** Closes an open disclosure panel on Esc (focus back on its button) or on a pointer outside it. */
function useDismiss(
  open: boolean,
  setOpen: (v: boolean) => void,
  root: RefObject<HTMLDivElement | null>,
  button: RefObject<HTMLButtonElement | null>,
): void {
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
  }, [open, setOpen, root, button]);
}

/** "Open in Web UI" (PW1.T7): the provider portal in a new tab, same language, this business. */
export function OpenInWebUi({ path, className, children }: { path?: string; className?: string; children?: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const { portalUrl } = usePwaConfig();
  const { active } = useWorkshop();
  return (
    <a href={portalHref(portalUrl, locale, active?.orgId ?? null, path)} target="_blank" rel="noopener" className={className}>
      {children ?? t('provider.menu.openWebUi')}
    </a>
  );
}

const roleKey = (b: Business) => `provider.business.role.${b.role}` as MessageKey;

/** Business name in the top bar; the panel switches business or goes to the personal app (RF-06). */
function BusinessSwitch() {
  const t = useT();
  const locale = useLocale();
  const { businesses, active, select } = useWorkshop();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, root, button);
  const panelId = useId();
  if (!active) {
    return (
      <span className="pwa-ws-brand">
        <Icon name="wrench" />
        <span>{t('provider.appName')}</span>
      </span>
    );
  }
  return (
    <div className="pwa-menu pwa-ws-switch" ref={root}>
      <button
        ref={button}
        type="button"
        className="pwa-ws-switch-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <span className="sr-only">{t('provider.business.switchLabel')}: </span>
        <span className="pwa-ws-switch-name">
          <bdi>{active.name}</bdi>
        </span>
        <span className="pwa-ws-switch-role">{t(roleKey(active))}</span>
        <Icon name="down" size={20} />
      </button>
      <div id={panelId} className={cx('pwa-menu-panel pwa-ws-switch-panel', !open && 'is-hidden')}>
        <p className="pwa-menu-heading">{t('provider.business.current')}</p>
        <ul className="pwa-menu-list">
          {(businesses ?? []).map((b) => (
            <li key={b.orgId}>
              <button
                type="button"
                className={cx('pwa-menu-item', b.orgId === active.orgId && 'is-active')}
                aria-current={b.orgId === active.orgId ? 'true' : undefined}
                onClick={() => {
                  select(b.orgId);
                  setOpen(false);
                }}
              >
                <Icon name="store" size={20} />
                <span className="pwa-stack-xs">
                  <bdi>{b.name}</bdi>
                  <span className="pwa-text-caption">{t(roleKey(b))}</span>
                </span>
              </button>
            </li>
          ))}
          <li>
            <Link href={`/${locale}/home`} className="pwa-menu-item" onClick={() => setOpen(false)}>
              <Icon name="user" size={20} />
              <span className="pwa-stack-xs">
                <span>{t('provider.business.personal')}</span>
                <span className="pwa-text-caption">{t('provider.business.personalHint')}</span>
              </span>
            </Link>
          </li>
          <li>
            <Link href={workshopPath(locale, 'start')} className="pwa-menu-item" onClick={() => setOpen(false)}>
              <Icon name="plus" size={20} />
              <span>{t('provider.business.add')}</span>
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

/** The Workshop menu: Open in Web UI, notification settings, language, theme, sign out (surfaces.workshop_pwa). */
function WorkshopMenu() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, root, button);
  const panelId = useId();
  return (
    <div className="pwa-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="cp-iconbtn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('provider.menu.label')}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      <div id={panelId} className={cx('pwa-menu-panel', !open && 'is-hidden')}>
        <nav aria-label={t('provider.menu.label')}>
          <ul className="pwa-menu-list">
            <li>
              <OpenInWebUi className="pwa-menu-item">
                <Icon name="globe" size={20} />
                <span className="pwa-stack-xs">
                  <span>{t('provider.menu.openWebUi')}</span>
                  <span className="pwa-text-caption">{t('provider.menu.openWebUiHint')}</span>
                </span>
              </OpenInWebUi>
            </li>
            <li>
              <Link href={`/${locale}/settings/notifications`} className="pwa-menu-item" onClick={() => setOpen(false)}>
                <Icon name="bell" size={20} />
                <span>{t('provider.menu.notifications')}</span>
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="pwa-menu-item"
                onClick={async () => {
                  setOpen(false);
                  await logout({ thenGo: workshopPath(locale, '') });
                  toast(t('provider.menu.signedOut'));
                }}
              >
                <Icon name="logout" size={20} />
                <span>{t('provider.menu.signOut')}</span>
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

const TAB_ICONS: Record<WorkshopTab, 'home' | 'calendar' | 'chat' | 'camera'> = {
  today: 'home',
  requests: 'calendar',
  replies: 'chat',
  photos: 'camera',
};

function WorkshopTabs() {
  const t = useT();
  const locale = useLocale();
  const current = workshopTabOf(usePathname()) ?? '';
  return (
    <TabBar
      className="pwa-ws-tabs"
      label={t('provider.tabs.label')}
      active={current}
      linkAs={Link}
      items={(Object.keys(TAB_ICONS) as WorkshopTab[]).map((id) => ({
        id,
        label: t(`provider.tabs.${id}` as MessageKey),
        icon: TAB_ICONS[id],
        href: workshopPath(locale, id),
      }))}
    />
  );
}

/** The Workshop frame: top bar and, with an active business, the tab bar. Guests see the bare frame (entry page). */
export function WorkshopFrame({ children }: { children: ReactNode }) {
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const { active } = useWorkshop();
  return (
    <div className={cx('pwa-ws', active && 'has-tabs')}>
      <header className="pwa-ws-top">
        <BusinessSwitch />
        {signedIn ? (
          <div className="pwa-ws-top-actions">
            {active ? <WorkshopBell business={active} /> : null}
            <WorkshopMenu />
          </div>
        ) : (
          <div className="pwa-ws-top-actions">
            <LanguageSwitch />
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1} className="pwa-ws-main">
        {children}
      </main>
      {active ? <WorkshopTabs /> : null}
    </div>
  );
}

/**
 * Below the session gate: the pages of the tabs need a provider business. While the memberships load → skeleton;
 * they failed → error with Retry; none → "Set up your workshop" (PW2 entry) and the way back to the personal app.
 */
export function WorkshopGate({ children }: { children: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const { businesses, active, error, retry } = useWorkshop();
  if (active) return <>{children}</>;
  if (error)
    return (
      <div className="pwa-ws-page">
        <StateBlock
          kind="error"
          headingLevel={2}
          title={t('provider.gate.errorTitle')}
          action={<Button onClick={retry}>{t('common.actions.retry')}</Button>}
        />
      </div>
    );
  if (!businesses) return <SkeletonList count={2} label={t('provider.gate.checking')} />;
  return (
    <div className="pwa-ws-page">
      <StateBlock
        kind="empty"
        headingLevel={2}
        title={t('provider.gate.noBusinessTitle')}
        text={t('provider.gate.noBusinessText')}
        action={
          <div className="pwa-inline-buttons">
            <Link href={workshopPath(locale, 'start')} className={buttonClass({ variant: 'primary' })}>
              <span className="cp-btn-label">{t('provider.gate.start')}</span>
            </Link>
            <Link href={`/${locale}/home`} className={buttonClass({ variant: 'ghost' })}>
              <span className="cp-btn-label">{t('provider.business.personal')}</span>
            </Link>
          </div>
        }
      />
    </div>
  );
}
