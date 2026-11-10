'use client';
// The console shell (AC4.T3, Docs/23 §3.1): top bar (wordmark, environment badge, lookup box, My queue, shortcuts,
// avatar menu), the left navigation filtered by the caller's staff roles (GD-09; the server still decides), and the
// main area. Below 1000 px the navigation folds behind a menu button. Around it: keyboard shortcuts (AC4.T7), step-up
// with action replay (AC4.T5) and the session watch with the idle warning (AC4.T4). The lookup box and the queue
// is a placeholder until AC10 (it says so; no dead actions, GD-08). My queue (AC5) links to My work with the number of
// changes waiting for the caller's approval.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import type { StaffRole } from '@/lib/api/generated';
import { useApiClient, useSession } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { queueKey, queuesFor, summarizeQueue } from '@/lib/work/queues';
import { useT } from '@/lib/i18n/client';
import { isSigninOutcome, outcomeMessage } from '@/features/auth';
import { AccountMenu } from './account-menu';
import { SECTION_GROUPS, sectionOfPath, visibleSections } from './sections';
import { SessionWatch } from './session-watch';
import { ShortcutProvider, useOpenShortcutHelp, useShortcut } from './shortcuts';
import { StepUpProvider } from './step-up';

export interface ConsoleShellProps {
  envBadge: ReactNode;
  themeChoice: string;
  children: ReactNode;
}

export function ConsoleShell({ envBadge, themeChoice, children }: ConsoleShellProps) {
  return (
    <ShortcutProvider>
      <StepUpProvider>
        <SessionWatch>
          <ShellFrame envBadge={envBadge} themeChoice={themeChoice}>
            {children}
          </ShellFrame>
        </SessionWatch>
      </StepUpProvider>
    </ShortcutProvider>
  );
}

function ShellFrame({ envBadge, themeChoice, children }: ConsoleShellProps) {
  const t = useT();
  const session = useSession();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [navFor, setNavFor] = useState(pathname);
  const navId = useId();
  const lookupHint = useId();
  const lookup = useRef<HTMLInputElement>(null);
  const openHelp = useOpenShortcutHelp();
  useShortcut('lookup', () => lookup.current?.focus());

  // A navigation closes the folded menu.
  if (navFor !== pathname) {
    setNavFor(pathname);
    setNavOpen(false);
  }

  const staff = session.data?.staff ?? null;
  const roles: readonly StaffRole[] = staff?.roles ?? [];
  const sections = visibleSections(roles);
  const current = sectionOfPath(pathname);

  return (
    <div className="adm-shell" data-nav-open={navOpen ? 'true' : 'false'}>
      <header className="adm-topbar">
        <IconButton
          className="adm-nav-toggle"
          icon={navOpen ? 'close' : 'list'}
          label={t(navOpen ? 'admin.shell.closeNav' : 'admin.shell.openNav')}
          aria-expanded={navOpen}
          aria-controls={navId}
          onClick={() => setNavOpen((v) => !v)}
        />
        <Link href="/" className="adm-wordmark">
          {t('admin.console.name')}
        </Link>
        {envBadge}
        <div className="adm-lookup" role="search">
          <label className="sr-only" htmlFor={`${lookupHint}-input`}>
            {t('admin.shell.lookup.label')}
          </label>
          <Icon name="search" size={20} />
          <input
            ref={lookup}
            id={`${lookupHint}-input`}
            className="adm-lookup-input"
            type="search"
            readOnly
            placeholder={t('admin.shell.lookup.placeholder')}
            aria-describedby={lookupHint}
          />
          <span id={lookupHint} className="sr-only">
            {t('admin.shell.lookup.soon')}
          </span>
          <kbd className="adm-lookup-key" lang="en" aria-hidden="true">
            /
          </kbd>
        </div>
        <MyQueue />
        <IconButton icon="help" label={t('admin.shell.shortcuts.open')} onClick={openHelp} />
        {staff ? (
          <Suspense fallback={null}>
            <AccountMenu name={staff.display_name} roles={roles} themeChoice={themeChoice} />
          </Suspense>
        ) : null}
      </header>
      <nav id={navId} className="adm-nav" aria-label={t('admin.shell.nav.label')}>
        {SECTION_GROUPS.map((group) => {
          const items = sections.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="adm-nav-group">
              <p className="adm-nav-heading" id={`${navId}-${group}`}>
                {t(`admin.shell.nav.groups.${group}`)}
              </p>
              <ul aria-labelledby={`${navId}-${group}`}>
                {items.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={s.path}
                      className="adm-nav-link"
                      aria-current={current?.id === s.id ? 'page' : undefined}
                      data-section={s.id}
                    >
                      <Icon name={s.icon} size={20} />
                      <span>{t(`admin.shell.nav.${s.id}`)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <main id="main" className="adm-main" tabIndex={-1}>
        <Suspense fallback={null}>
          <SigninNotice />
        </Suspense>
        {children}
      </main>
    </div>
  );
}

/** My queue (AC5): a link to My work; for staff who decide four-eyes changes, the number waiting (refreshed each minute). */
function MyQueue() {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const session = useSession();
  const queue = queuesFor(session.data?.staff?.roles ?? []).find((q) => q.id === 'approvals');
  const summary = useQuery({
    queryKey: queueKey('approvals'),
    queryFn: ({ signal }) => summarizeQueue(api, queue!, { timeZone: f.timeZone, signal }),
    enabled: !!queue,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const n = summary.data ? (summary.data.capped ? `${f.number(summary.data.count)}+` : f.number(summary.data.count)) : null;
  return (
    <Link href="/" className="adm-queue" data-testid="my-queue" data-count={summary.data?.count ?? ''}>
      <Icon name="list" size={20} />
      <span>{t('admin.shell.myQueue')}</span>
      {queue && n !== null ? (
        <>
          <span className="adm-queue-count" aria-hidden="true">
            {n}
          </span>
          <span className="sr-only">{t('admin.shell.myQueueCount', { n })}</span>
        </>
      ) : null}
    </Link>
  );
}

/**
 * A sign-in that came back with ?signin=<outcome> while the staff member is still signed in (a step-up by someone
 * else, or without the security key): the action did not run; say why, then drop the parameter.
 */
function SigninNotice() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const outcome = params.get('signin');
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!isSigninOutcome(outcome)) return;
    const rest = new URLSearchParams(params);
    rest.delete('signin');
    router.replace(`${pathname}${rest.size ? `?${rest.toString()}` : ''}`, { scroll: false });
  }, [outcome, params, pathname, router]);

  if (isSigninOutcome(outcome) && shown !== outcome) setShown(outcome);
  if (!isSigninOutcome(shown)) return null;
  return (
    <div className="adm-notice">
      <Banner tone="warn" text={t(outcomeMessage(shown))} />
    </div>
  );
}
