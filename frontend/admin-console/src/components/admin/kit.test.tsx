// AC5.T8 DOM tests of the admin kit: reasons are required (no write without one), irreversible actions need a second
// confirmation, four-eyes outcomes and SELF_APPROVAL_FORBIDDEN are explained, purpose-bound reads need a work item,
// masked fields reveal through a re-read, the data table (keyboard, columns, saved views without data, Latin digits,
// paging, states), the case layout, entity chips, timeline, AI evidence, the audit drawer (ADM only, Shift+H) — and
// axe in English and Persian.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import { ApiProblem } from '@/lib/api/problem';
import type { Locale } from '@/lib/i18n/locales';
import {
  ActionNotice,
  AiEvidenceBlock,
  AuditDrawer,
  CaseLayout,
  ConfirmDialog,
  DataTable,
  EntityChip,
  MaskedField,
  MY_CHANGES_KEY,
  PurposeGate,
  ReasonDialog,
  ReasonMissingError,
  SlaBadge,
  Timeline,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  withPurpose,
  parsePurpose,
  maskPhone,
  maskEmail,
  maskName,
  maskTail,
  type Column,
  type FilterDef,
} from './index';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ID = '0193a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const CHANGE: PendingChange = {
  change_id: ID,
  op_id: 'admin.retention_update',
  summary: 'Retention VerificationToken: 7 d delete → 7 d delete (active)',
  requested_by_display: 'Ali Admin',
  requested_at: '2026-11-09T08:00:00Z',
  reason: 'planned_change: yearly review',
  status: 'pending',
  expires_at: '2026-11-12T08:00:00Z',
};

beforeEach(() => {
  resetNav('/');
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('ReasonDialog and ConfirmDialog (AC5.T2)', () => {
  function Harness({ kind, irreversible = false }: { kind: 'approve_change' | 'reject_change'; irreversible?: boolean }) {
    const [sent, setSent] = useState<string | null>(null);
    return (
      <>
        <ReasonDialog
          open
          onClose={() => undefined}
          kind={kind}
          title="Decide"
          confirmLabel="Confirm"
          irreversible={irreversible}
          onSubmit={(reason) => setSent(reason)}
        />
        <p data-testid="sent">{sent ?? 'nothing'}</p>
      </>
    );
  }

  it('sends nothing without a reason code', () => {
    renderConsole(<Harness kind="approve_change" />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Choose a reason.')).toBeInTheDocument();
    expect(screen.getByTestId('sent')).toHaveTextContent('nothing');
  });

  it('requires a note for a rejection, then sends "<code>: <note>"', () => {
    renderConsole(<Harness kind="reject_change" />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'values_incorrect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Write a note: it is required for this action.')).toBeInTheDocument();
    expect(screen.getByTestId('sent')).toHaveTextContent('nothing');
    fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: 'The new value\nis wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByTestId('sent')).toHaveTextContent('values_incorrect: The new value is wrong');
  });

  it('asks for a second confirmation before an irreversible action', () => {
    renderConsole(<Harness kind="approve_change" irreversible />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tick the box to confirm.');
    expect(screen.getByTestId('sent')).toHaveTextContent('nothing');
    fireEvent.click(screen.getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByTestId('sent')).toHaveTextContent('planned_change');
  });

  it('ConfirmDialog without a reason still needs the tick for irreversible actions', () => {
    const onConfirm = vi.fn();
    renderConsole(
      <ConfirmDialog open onClose={() => undefined} title="Delete" confirmLabel="Delete now" irreversible onConfirm={onConfirm}>
        <p>Deletes the data.</p>
      </ConfirmDialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('useAdminAction (AC5.T2/T4)', () => {
  function Action({ reason, onError }: { reason: string; onError?: (e: unknown) => void }) {
    const action = useAdminAction('admin.four_eyes_decide');
    const queryClient = useQueryClient();
    const mine = queryClient.getQueryData<PendingChange[]>(MY_CHANGES_KEY) ?? [];
    return (
      <>
        <button
          type="button"
          onClick={() =>
            action.run({ path: { change_id: ID }, body: { decision: 'approve', reason }, reason }).catch((e: unknown) => onError?.(e))
          }
        >
          Go
        </button>
        <ActionNotice state={action.state} />
        <p data-testid="mine">{mine.length}</p>
      </>
    );
  }

  it('never sends an RSN operation without a valid reason', async () => {
    const { transport, calls } = scriptedTransport({});
    const onError = vi.fn();
    renderConsole(<Action reason="  " onError={onError} />, { transport });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ReasonMissingError);
    expect(calls).toHaveLength(0);
  });

  it('sends the reason in the body and shows "applied"', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.four_eyes_decide': () => Response.json({ ...CHANGE, status: 'approved' }) });
    renderConsole(<Action reason="checked_and_correct" />, { transport });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('Done.')).toBeInTheDocument();
    expect(calls[0]!.body).toEqual({ decision: 'approve', reason: 'checked_and_correct' });
  });

  it('a 202 PendingChange shows the four-eyes banner and joins "my requests"', async () => {
    const { transport } = scriptedTransport({ 'admin.four_eyes_decide': () => Response.json(CHANGE, { status: 202 }) });
    renderConsole(<Action reason="planned_change" />, { transport });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(screen.getByText(/Data retention change was filed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Pending approvals' })).toHaveAttribute('href', '/approvals');
    await waitFor(() => expect(screen.getByTestId('mine')).toHaveTextContent('1'));
  });

  it('explains SELF_APPROVAL_FORBIDDEN as a rule, not a failure', async () => {
    const { transport } = scriptedTransport({ 'admin.four_eyes_decide': () => problem(403, 'SELF_APPROVAL_FORBIDDEN') });
    renderConsole(<Action reason="planned_change" />, { transport });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('Someone else must decide this')).toBeInTheDocument();
    expect(screen.getByText(/You requested this change yourself/)).toBeInTheDocument();
  });

  it('STEP_UP_REQUIRED opens the security-key confirmation and saves the action for one replay', async () => {
    const { transport } = scriptedTransport({
      'admin.four_eyes_decide': () =>
        problem(401, 'STEP_UP_REQUIRED', {
          'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600',
        }),
    });
    const { bff } = renderConsole(<Action reason="planned_change" />, { transport });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm with security key' }));
    await waitFor(() => expect(bff.posted.find((p) => p.url === '/bff/intents')).toBeTruthy());
    const saved = bff.posted.find((p) => p.url === '/bff/intents')!.body as { type: string; draft: { args: { reason: string } } };
    expect(saved.type).toBe('act.admin.four_eyes_decide');
    expect(saved.draft.args.reason).toBe('planned_change');
  });
});

describe('PurposeGate and MaskedField (AC5.T3)', () => {
  it('without a work item it asks to open one and lists the queues of the role', () => {
    renderConsole(<PurposeGate>{(p) => <p>read with {p}</p>}</PurposeGate>, { roles: ['MOD'] });
    expect(screen.getByText('Open this from a work item')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Disputes & appeals' })).toHaveAttribute('href', '/disputes');
    expect(screen.queryByText(/read with/)).toBeNull();
  });

  it('with ?purpose= the content gets the purpose; links keep it', () => {
    resetNav(`/users/x?purpose=case:${ID}`);
    renderConsole(<PurposeGate>{(p) => <p>read with {p}</p>}</PurposeGate>);
    expect(screen.getByText(`read with case:${ID}`)).toBeInTheDocument();
    expect(withPurpose('/orgs/1?tab=a', `case:${ID}`)).toBe(`/orgs/1?tab=a&purpose=case%3A${ID}`);
    expect(parsePurpose('case:nope')).toBeNull();
    expect(parsePurpose(`user:${ID}`)).toBeNull();
  });

  it('masks by default and reveals through a purpose-bound re-read', async () => {
    const onReveal = vi.fn(async () => '+989121234567');
    renderConsole(
      <dl>
        <MaskedField label="Phone" kind="phone" value="+989121234567" onReveal={onReveal} />
        <MaskedField label="Email" kind="email" value="mina@example.com" />
      </dl>,
    );
    expect(screen.getByText('+98 912 *** 4567')).toBeInTheDocument();
    expect(screen.getByText('m***@e***.com')).toBeInTheDocument();
    expect(screen.getByText('Open from a work item to reveal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('+989121234567')).toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByText('+98 912 *** 4567')).toBeInTheDocument();
  });

  it('mask functions', () => {
    expect(maskPhone('09121234567')).toBe('091 *** 4567');
    expect(maskPhone('123')).toBe('***');
    expect(maskEmail('a@b')).toBe('a***@b***');
    expect(maskName('Mina  Karimi')).toBe('M*** K***');
    expect(maskTail('1HGCM82633A004352', 4)).toBe('***4352');
    expect(maskTail('12', 2)).toBe('***');
  });
});

interface Row {
  id: string;
  name: string;
  status: string;
}
const ROWS: Row[] = [
  { id: 'r-101', name: 'First', status: 'open' },
  { id: 'r-102', name: 'Second', status: 'open' },
  { id: 'r-103', name: 'Third', status: 'closed' },
];

function TableHarness({ rows = ROWS, loading = false }: { rows?: Row[] | null; loading?: boolean }) {
  const defs: FilterDef[] = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Closed' },
      ],
      defaultValue: 'open',
    },
  ];
  const filters = useUrlFilters(defs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const [selected, setSelected] = useState<string | null>(null);
  const columns: Column<Row>[] = [
    { id: 'name', header: 'Name', pinned: true, cell: (r) => r.name },
    { id: 'code', header: 'Code', cell: (r, ctx) => ctx.digits(r.id) },
    { id: 'status', header: 'State', cell: (r) => r.status },
  ];
  return (
    <>
      <DataTable
        id="test"
        caption="Test rows"
        columns={columns}
        rows={rows ?? undefined}
        rowKey={(r) => r.id}
        loading={loading}
        emptyText="Nothing here."
        selectedKey={selected}
        onSelect={(r) => setSelected(r.id)}
        filters={defs}
        filterValues={filters.values}
        onFilterChange={filters.setFilter}
        onApplyView={filters.applyView}
        paging={{
          page: paging.page,
          hasPrev: paging.page > 1,
          hasNext: true,
          onPrev: paging.prev,
          onNext: () => paging.next(`c${paging.page}`),
        }}
      />
      <p data-testid="selected">{selected ?? 'none'}</p>
      <p data-testid="cursor">{paging.cursor ?? 'first'}</p>
      <p data-testid="status">{filters.values.status}</p>
    </>
  );
}

describe('DataTable (AC5.T1)', () => {
  it('renders rows with a fixed header, selects with click, ↑/↓ and J/K', () => {
    renderConsole(<TableHarness />);
    const table = screen.getByRole('table', { name: 'Test rows' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Code', 'State']);
    const first = screen.getByRole('button', { name: 'First' });
    fireEvent.click(first);
    expect(screen.getByTestId('selected')).toHaveTextContent('r-101');
    expect(first.closest('tr')).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(screen.getByTestId('selected')).toHaveTextContent('r-102');
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    expect(screen.getByTestId('selected')).toHaveTextContent('r-103');
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK' });
    expect(screen.getByTestId('selected')).toHaveTextContent('r-102');
  });

  it('shows loading, empty and error states', () => {
    const first = renderConsole(<TableHarness rows={null} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    first.unmount();
    const second = renderConsole(<TableHarness rows={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here.');
    second.unmount();
    renderConsole(
      <DataTable
        id="err"
        caption="Broken"
        columns={[{ id: 'a', header: 'A', cell: () => 'a' }]}
        rows={undefined}
        rowKey={() => 'a'}
        error={new ApiProblem(503, { code: 'UNAVAILABLE' })}
        onRetry={() => undefined}
        emptyText="none"
      />,
    );
    expect(screen.getByText('Something went wrong. Try again; if it keeps failing, report the request ID.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('binds filters to the URL (unknown values fall back) and starts again at page 1 when they change', () => {
    resetNav('/x?status=bogus');
    renderConsole(<TableHarness />);
    expect(screen.getByTestId('status')).toHaveTextContent('open');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('cursor')).toHaveTextContent('c1');
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'closed' } });
    expect(nav.replaced.at(-1)).toBe('/x?status=closed');
    expect(screen.getByTestId('cursor')).toHaveTextContent('first');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'open' } });
    expect(nav.replaced.at(-1)).toBe('/x');
  });

  it('hides columns and saves views in this browser without any data', () => {
    resetNav('/x?status=closed');
    renderConsole(<TableHarness />);
    fireEvent.click(screen.getByLabelText('Code'));
    expect(screen.queryByRole('columnheader', { name: 'Code' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Name for the current filters'), { target: { value: 'Closed ones' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    const stored = JSON.parse(window.localStorage.getItem('cpa.table.test')!) as unknown;
    expect(stored).toEqual({ hidden: ['code'], views: [{ name: 'Closed ones', filters: { status: 'closed' } }] });
    resetNav('/x');
    fireEvent.click(screen.getByRole('button', { name: 'Closed ones' }));
    expect(nav.replaced.at(-1)).toBe('/x?status=closed');
  });

  it('keeps IDs in Persian digits unless the staff member chooses Latin digits', () => {
    renderConsole(<TableHarness />, { locale: 'fa' });
    expect(screen.getByText('r-۱۰۱')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('رقم لاتین برای شناسه‌ها'));
    expect(screen.getByText('r-101')).toBeInTheDocument();
    expect(window.localStorage.getItem('cpa.latin-ids')).toBe('1');
  });
});

describe('case layout, entity chip, timeline, AI evidence, SLA (AC5.T5)', () => {
  it('has three labelled regions', () => {
    renderConsole(<CaseLayout list={<p>list</p>} item={<p>item</p>} decision={<p>decision</p>} />);
    expect(screen.getByRole('region', { name: 'Queue' })).toHaveTextContent('list');
    expect(screen.getByRole('region', { name: 'Item' })).toHaveTextContent('item');
    expect(screen.getByRole('region', { name: 'Decision' })).toHaveTextContent('decision');
  });

  it('an entity chip opens a preview with a link; Escape closes it and returns focus', () => {
    renderConsole(<EntityChip type="organization" id={ID} label="Pars Auto" href={`/orgs/${ID}`} preview={<p>Verified</p>} />);
    const chip = screen.getByRole('button', { name: /Pars Auto/ });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    const panel = screen.getByRole('group', { name: 'Organization' });
    expect(within(panel).getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/orgs/${ID}`);
    expect(within(panel).getByText('Verified')).toBeInTheDocument();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveFocus();
  });

  it('unknown entity types read "Unknown (…)"', () => {
    renderConsole(<EntityChip type="spaceship" id="x1" />);
    expect(screen.getByRole('button', { name: /Unknown \(spaceship\)/ })).toBeInTheDocument();
  });

  it('timeline lists events with time and actor', () => {
    renderConsole(
      <Timeline
        items={[
          { id: '1', at: '2026-11-09T08:00:00Z', title: 'Opened', actor: 'Mina' },
          { id: '2', at: '2026-11-09T09:00:00Z', title: 'Hidden' },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.adm-timeline-title')?.textContent)).toEqual(['Opened', 'Hidden']);
    expect(items[0]).toHaveTextContent('Mina');
  });

  it('AI evidence is labelled as input; only ADM gets a link to the MCP log', () => {
    const block = (
      <AiEvidenceBlock title="Risk assessment" riskScore={82} reasons={['new account']} model="m-1" promptVersion="p-3" mcpLogId="log-9" />
    );
    const { unmount } = renderConsole(block, { roles: ['ADM'] });
    expect(screen.getByText('An input for your decision. AI never decides.')).toBeInTheDocument();
    expect(screen.getByText('Risk 82')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'log-9' })).toHaveAttribute('href', '/mcp?log=log-9');
    unmount();
    renderConsole(block, { roles: ['MOD'] });
    expect(screen.queryByRole('link', { name: 'log-9' })).toBeNull();
    expect(screen.getByText('log-9')).toBeInTheDocument();
  });

  it('SLA badges say their state in words', () => {
    renderConsole(
      <>
        <SlaBadge state="ok" />
        <SlaBadge state="breach" />
      </>,
    );
    expect(screen.getByText('On time')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });
});

describe('AuditDrawer (AC5.T6)', () => {
  const ENTRY = {
    id: 'a1',
    actor_type: 'platform_staff',
    actor_display: 'Ali Admin',
    organization_id: null,
    action: 'admin.four_eyes_requested',
    entity_type: 'data_retention_policy',
    entity_id: ID,
    previous_state_summary: null,
    new_state_summary: 'admin.retention_update pending',
    reason: 'planned_change: yearly review',
    request_id: 'r1',
    created_at: '2026-11-09T08:00:00Z',
  };

  it('ADM: Shift+H opens the trail of this record (last 92 days) with reasons in words', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.audit_search': () => page([ENTRY]) });
    renderConsole(<AuditDrawer entityType="data_retention_policy" entityId={ID} label="Retention" />, { transport, roles: ['ADM'] });
    fireEvent.keyDown(document.body, { key: 'H', code: 'KeyH', shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Audit trail: Retention' });
    expect(await within(dialog).findByText('admin.four_eyes_requested')).toBeInTheDocument();
    expect(within(dialog).getByText('Planned change')).toBeInTheDocument();
    expect(within(dialog).getByText('yearly review')).toBeInTheDocument();
    const body = calls[0]!.body as { entity_type: string; entity_id: string; from: string; to: string; limit: number };
    expect(body).toMatchObject({ entity_type: 'data_retention_policy', entity_id: ID, limit: 50 });
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(92);
  });

  it('other roles see that the audit is for platform admins, and nothing is read', async () => {
    const { transport, calls } = scriptedTransport({});
    renderConsole(<AuditDrawer entityType="case" entityId={ID} />, { transport, roles: ['MOD'] });
    fireEvent.click(screen.getByRole('button', { name: 'Audit trail' }));
    expect(await screen.findByText('Audit visible to platform admins.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('axe: the kit in English and Persian (AC5 acceptance)', () => {
  function Gallery() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <h1>Kit</h1>
        <CaseLayout
          list={<TableHarness />}
          item={
            <>
              <dl>
                <MaskedField label="Phone" kind="phone" value="+989121234567" onReveal={async () => '+989121234567'} />
              </dl>
              <EntityChip type="user" id={ID} label="Mina" href="/users/x" />
              <Timeline items={[{ id: '1', at: '2026-11-09T08:00:00Z', title: 'Opened', actor: 'Mina' }]} />
              <AiEvidenceBlock title="Risk" riskScore={40} reasons={['spam words']} model="m" promptVersion="p" mcpLogId="l1" />
              <SlaBadge state="warn" />
            </>
          }
          decision={<AuditDrawer entityType="case" entityId={ID} />}
        />
        <ReasonDialog
          open={open}
          onClose={() => setOpen(false)}
          kind="reject_change"
          title="Reject"
          confirmLabel="Reject"
          irreversible
          onSubmit={() => undefined}
        />
      </>
    );
  }

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({});
      renderConsole(<Gallery />, { locale, transport, roles: ['MOD'] });
      await act(async () => undefined);
      expect(document.documentElement.dir).toBe(locale === 'fa' ? 'rtl' : 'ltr');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
