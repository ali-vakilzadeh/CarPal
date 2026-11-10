'use client';
// Assist sessions (AC9.T5, Docs/40 admin.assist_session_start / admin.assist_session_end, Docs/23 "Assist
// onboarding", DI-08). Support staff and platform admins open a 4-hour session to help an owner through the business
// onboarding; the assisted calls ({adm}/assist/{id}/…) and the wizard itself wait for the business web app (DI-08), so
// the console starts and ends the session and shows it while it is open: a banner on every console page with the
// organization, the end time and "End the session". The contract has no read of open sessions (BR-34), so the console
// keeps the ones started on this page in memory and forgets a session when it ends, expires or the backend says it is
// no longer open.
import Link from 'next/link';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import type { FlowType } from './org-logic';

export interface AssistSession {
  id: string;
  /** The staff member who started it: another staff member signing in on this tab never sees it. */
  staffId: string;
  orgId: string;
  orgName: string;
  flow: FlowType;
  expiresAt: string;
}

// In memory only (GD-12: nothing from a response goes to Web Storage, lint-enforced): the list lives as long as the
// console page does; a reload forgets it (the session still ends by itself after 4 hours, D-62, BR-34).
const subs = new Set<() => void>();
let sessions: AssistSession[] = [];

function write(list: AssistSession[]): void {
  sessions = list;
  for (const fn of subs) fn();
}

export const assistStore = {
  add(s: AssistSession) {
    write([s, ...sessions.filter((x) => x.id !== s.id)].slice(0, 10));
  },
  remove(id: string) {
    write(sessions.filter((x) => x.id !== id));
  },
  clear() {
    write([]);
  },
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  snapshot: () => sessions,
};

const EMPTY: AssistSession[] = [];

/** The open sessions this staff member started in this tab (expired ones are dropped). */
export function useAssistSessions(staffId: string | undefined, now: number): AssistSession[] {
  const list = useSyncExternalStore(assistStore.subscribe, assistStore.snapshot, () => EMPTY);
  return staffId ? list.filter((s) => s.staffId === staffId && Date.parse(s.expiresAt) > now) : EMPTY;
}

/** The banner of every console page while an assist session started here is open (DI-08). */
export function AssistBanner() {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const canEnd = canCall('admin.assist_session_end', session.data?.staff?.roles ?? []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const open = useAssistSessions(session.data?.staff?.id, now);
  if (!canEnd || !open.length) return null;
  return (
    <div className="adm-assist" data-testid="assist-banner">
      {open.map((s) => (
        <AssistRow key={s.id} s={s} untilText={f.date(s.expiresAt, 'time')} t={t} />
      ))}
    </div>
  );
}

function AssistRow({ s, untilText, t }: { s: AssistSession; untilText: string; t: ReturnType<typeof useT> }) {
  const [dialog, setDialog] = useState(false);
  const end = useAdminAction('admin.assist_session_end', {
    target: s.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') assistStore.remove(s.id);
    },
  });
  const failed = end.state.status === 'failed' ? end.state.problem : null;
  // A session that ended elsewhere or expired: the backend answers 404/409; forget it.
  useEffect(() => {
    if (failed && (failed.status === 404 || failed.code === 'INVALID_TRANSITION')) assistStore.remove(s.id);
  }, [failed, s.id]);
  const submit = useCallback(
    (reason: string) => {
      setDialog(false);
      void end.run({ path: { assist_session_id: s.id }, body: { reason }, reason });
    },
    [end, s.id],
  );
  return (
    <Banner tone="warn" icon="user" title={t('admin.orgs.assist.bannerTitle')}>
      <p className="pwa-banner-text">
        {t('admin.orgs.assist.bannerText', { flow: t(`admin.orgs.assist.flow.${s.flow}`), until: untilText })}{' '}
        <Link href={`/orgs/${s.orgId}`}>
          <Bidi>{s.orgName}</Bidi>
        </Link>
      </p>
      <p className="pwa-banner-text adm-muted">{t('admin.orgs.assist.bannerNote')}</p>
      <div className="adm-actions">
        <Button size="sm" variant="secondary" loading={end.state.status === 'busy'} onClick={() => setDialog(true)}>
          {t('admin.orgs.assist.end')}
        </Button>
      </div>
      <ActionNotice state={end.state} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="assist_end"
        title={t('admin.orgs.assist.endTitle')}
        confirmLabel={t('admin.orgs.assist.end')}
        summary={
          <p>
            <Bidi>{s.orgName}</Bidi>
          </p>
        }
        onSubmit={submit}
        name="assist-end"
      />
    </Banner>
  );
}
