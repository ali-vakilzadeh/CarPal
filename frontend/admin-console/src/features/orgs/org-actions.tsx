'use client';
// Organization actions of the page header (AC9.T5, Docs/23 A-ORG-02 buttons, Docs/40 admin.org_status,
// admin.assist_session_start). Suspend takes the organization's public profiles off search and the map (a second
// confirmation, a reason with a note; never bulk, Docs/23 §3.3); Reactivate puts them back. Neither needs a purpose
// (the operation is RSN, not PURP), so a moderator can act from the header even without a work item. Merge is hidden
// until the re-pointing registry exists (BR-08, D-51). Assist onboarding starts a 4-hour session for one of the flows
// the organization type has; the session is shown on every page until it ends (assist.tsx).
import { useRef, useState } from 'react';
import type { StaffOrgView } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { assistStore } from './assist';
import { assistFlows, statusChanges, STATUS_TARGET, type FlowType, type StatusChange } from './org-logic';

type Org = Pick<StaffOrgView, 'id' | 'name' | 'status' | 'organization_type'>;

export function StatusActions({ org, onChanged }: { org: Org; onChanged: (o: StaffOrgView) => void }) {
  const t = useT();
  const session = useSession();
  const allowed = canCall('admin.org_status', session.data?.staff?.roles ?? []);
  const [dialog, setDialog] = useState<StatusChange | null>(null);
  const [last, setLast] = useState<StatusChange | null>(null);
  const action = useAdminAction('admin.org_status', {
    target: org.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') onChanged(o.data);
    },
  });
  if (!allowed) return null;
  const changes = statusChanges(org.status);
  const submit = (reason: string) => {
    const change = dialog;
    setDialog(null);
    if (!change) return;
    setLast(change);
    void action.run({ path: { org_id: org.id }, body: { status: STATUS_TARGET[change], reason }, reason });
  };
  return (
    <>
      {changes.map((c) => (
        <Button
          key={c}
          size="sm"
          variant={c === 'suspend' ? 'danger' : 'secondary'}
          icon={c === 'suspend' ? 'lock' : 'refresh'}
          loading={action.state.status === 'busy' && last === c}
          disabled={action.state.status === 'busy'}
          onClick={() => {
            action.reset();
            setDialog(c);
          }}
        >
          {t(`admin.orgs.status.do.${c}`)}
        </Button>
      ))}
      <div className="adm-header-notice">
        <ActionNotice state={action.state} applied={last ? t(`admin.orgs.status.done.${last}`) : undefined} />
      </div>
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'suspend' ? 'suspension' : 'restore'}
        title={dialog ? t(`admin.orgs.status.dialog.${dialog}`) : ''}
        confirmLabel={dialog ? t(`admin.orgs.status.do.${dialog}`) : ''}
        confirmVariant={dialog === 'suspend' ? 'danger' : 'primary'}
        irreversible={dialog === 'suspend'}
        summary={
          dialog ? (
            <>
              <p>
                <Bidi>{org.name}</Bidi>
              </p>
              <p className="adm-muted">{t(`admin.orgs.status.effect.${dialog}`)}</p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="org-status"
      />
    </>
  );
}

export function AssistStart({ org }: { org: Org }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const staffId = session.data?.staff?.id;
  const allowed = canCall('admin.assist_session_start', session.data?.staff?.roles ?? []);
  const flows = assistFlows(org.organization_type, org.status);
  const [flow, setFlow] = useState<FlowType | null>(null);
  const [dialog, setDialog] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const lastFlow = useRef<FlowType | null>(null);
  const action = useAdminAction('admin.assist_session_start', {
    target: org.id,
    onOutcome: (o) => {
      if (o.kind !== 'applied' || !staffId) return;
      assistStore.add({
        id: o.data.assist_session_id,
        staffId,
        orgId: org.id,
        orgName: org.name,
        flow: lastFlow.current ?? flows[0]!,
        expiresAt: o.data.expires_at,
      });
      setStarted(o.data.expires_at);
    },
  });
  if (!allowed || !flows.length) return null;
  const chosen = flow ?? flows[0]!;
  const submit = (reason: string) => {
    setDialog(false);
    lastFlow.current = chosen;
    void action.run({ path: { org_id: org.id }, body: { flow_type: chosen, reason }, reason });
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon="user"
        loading={action.state.status === 'busy'}
        onClick={() => {
          action.reset();
          setStarted(null);
          setFlow(flows[0]!);
          setDialog(true);
        }}
      >
        {t('admin.orgs.assist.start')}
      </Button>
      <div className="adm-header-notice">
        <ActionNotice
          state={action.state}
          applied={started ? t('admin.orgs.assist.started', { until: f.date(started, 'time') }) : undefined}
        />
      </div>
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="assist_start"
        title={t('admin.orgs.assist.startTitle')}
        confirmLabel={t('admin.orgs.assist.start')}
        summary={
          <>
            <p>
              <Bidi>{org.name}</Bidi>
            </p>
            {flows.length > 1 ? (
              <fieldset className="adm-radios">
                <legend>{t('admin.orgs.assist.flowLabel')}</legend>
                {flows.map((x) => (
                  <label key={x}>
                    <input type="radio" name="assist-flow" value={x} checked={chosen === x} onChange={() => setFlow(x)} />{' '}
                    {t(`admin.orgs.assist.flow.${x}`)}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p>{t('admin.orgs.assist.flowOnly', { flow: t(`admin.orgs.assist.flow.${chosen}`) })}</p>
            )}
            <p className="adm-muted">{t('admin.orgs.assist.effect')}</p>
          </>
        }
        onSubmit={submit}
        name="assist-start"
      />
    </>
  );
}
