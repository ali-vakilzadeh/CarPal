// AC6.T3/T4 tests of Plans & entitlements: the plan rules (changed entitlements only, audiences per subscriber, the
// end of a day in the staff member's time zone, links from other screens), and the screen: the ranking rule on
// screen, a plan edit sent as a four-eyes change with only what changed, and the assignment form (organization
// found by name, trial end required, overrides, the request body, the result, unknown subscriber); axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange, Plan, StaffOrgView, Subscription } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, searchRow } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { audiencesOf, changedEntitlements, dayIn, draftsOf, endOfDayIso, parseSubscriberParam } from './plan-logic';
import { PlansPage } from './plans-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ORG = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const USER = '0193a3c4-5d6e-7f80-9a1b-0000000000e1';

const fleet20: Plan = {
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000f1',
  plan_key: 'fleet_20',
  audience: 'fleet',
  name_i18n_key: 'plans.fleet_20',
  max_vehicles: 20,
  max_users: 5,
  trial_days: 30,
  entitlements: [
    { key: 'max_vehicles', value: 20 },
    { key: 'max_fleet_users', value: 5 },
    { key: 'ai_tools_enabled', value: true },
    { key: 'fleet_reports_enabled', value: false },
  ],
};
const free: Plan = {
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000f2',
  plan_key: 'individual_free',
  audience: 'individual',
  name_i18n_key: 'plans.individual_free',
  max_vehicles: 5,
  max_users: null,
  trial_days: null,
  entitlements: [
    { key: 'max_vehicles', value: 5 },
    { key: 'ai_tools_enabled', value: true },
  ],
};
const providerBasic: Plan = { ...free, id: '0193a3c4-5d6e-7f80-9a1b-0000000000f3', plan_key: 'provider_basic', audience: 'provider' };

const pending: PendingChange = {
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000ab',
  op_id: 'admin.plan_update',
  summary: 'Plan fleet_20: max_vehicles=25',
  requested_by_display: 'Sara Staff',
  requested_at: new Date().toISOString(),
  reason: 'planned_change',
  status: 'pending',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
};

function org(o: Partial<StaffOrgView> = {}): StaffOrgView {
  return {
    id: ORG,
    name: 'Tehran Logistics',
    organization_type: 'fleet',
    status: 'active',
    subscription: { plan: free, status: 'active' } as Subscription,
    locations: [],
    verifications: [],
    member_count: 4,
    open_cases: 0,
    ...o,
  } as StaffOrgView;
}

function subscription(o: Partial<Subscription> = {}): Subscription {
  return {
    id: '0193a3c4-5d6e-7f80-9a1b-000000000099',
    created_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:00:00Z',
    version: 1,
    plan: fleet20,
    status: 'trial',
    billing_mode: 'manual',
    started_at: '2026-11-10T08:00:00Z',
    trial_ends_at: '2026-12-10T20:29:59Z',
    expires_at: null,
    effective_entitlements: [
      { key: 'max_vehicles', value: 30 },
      { key: 'ai_tools_enabled', value: true },
    ],
    usage: {},
    ...o,
  };
}

beforeEach(() => resetNav('/plans'));
afterEach(() => vi.unstubAllGlobals());

describe('plan rules (AC6.T3/T4)', () => {
  it('keeps only changed entitlements and finds bad numbers', () => {
    const d = draftsOf(fleet20.entitlements);
    expect(changedEntitlements(fleet20, d)).toEqual({ changes: [] });
    expect(
      changedEntitlements(fleet20, {
        ...d,
        max_vehicles: { kind: 'int', text: '۲۵', unlimited: false },
        max_fleet_users: { kind: 'int', text: '', unlimited: true },
        fleet_reports_enabled: { kind: 'bool', value: true },
      }),
    ).toEqual({
      changes: [
        { key: 'max_vehicles', value: 25 },
        { key: 'max_fleet_users', value: null },
        { key: 'fleet_reports_enabled', value: true },
      ],
    });
    expect(changedEntitlements(fleet20, { ...d, max_vehicles: { kind: 'int', text: '-1', unlimited: false } })).toEqual({
      invalid: ['max_vehicles'],
    });
  });

  it('plans per subscriber, link parameters and the end of a day in Tehran', () => {
    expect(audiencesOf({ type: 'user' })).toEqual(['individual']);
    expect(audiencesOf({ type: 'organization', orgType: 'hybrid_provider_vendor' })).toEqual(['provider', 'vendor']);
    expect(audiencesOf({ type: 'organization' })).toEqual(['fleet', 'provider', 'vendor']);
    expect(parseSubscriberParam(`organization:${ORG}`)).toEqual({ type: 'organization', id: ORG });
    expect(parseSubscriberParam('user:nope')).toBeNull();
    expect(endOfDayIso('2026-12-10', 'Asia/Tehran')).toBe('2026-12-10T20:29:59.000Z');
    expect(endOfDayIso('2026-12-10', 'UTC')).toBe('2026-12-10T23:59:59.000Z');
    expect(endOfDayIso('10/12/2026', 'UTC')).toBeNull();
    expect(dayIn('UTC', 1, Date.parse('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
  });
});

describe('Plans & entitlements page (AC6.T3/T4)', () => {
  it('shows the ranking rule; a plan edit sends only what changed and waits for a second admin', async () => {
    resetNav(`/plans?plan=${fleet20.id}`);
    const { transport, calls } = scriptedTransport({
      'admin.plans_list': () => page([free, fleet20]),
      'admin.plan_update': () => Response.json(pending, { status: 202 }),
    });
    renderConsole(<PlansPage />, { transport, roles: ['ADM'] });
    expect(screen.getByTestId('ranking-rule')).toHaveTextContent('Plans never change organic ranking');
    const editor = await screen.findByTestId('plan-editor');
    const save = within(editor).getByRole('button', { name: 'Send for approval' });
    expect(save).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText('Vehicles'), { target: { value: '25' } });
    fireEvent.click(within(editor).getByLabelText('Fleet reports'));
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: 'Change Fleet 20' });
    expect(within(dialog).getByText('Vehicles: 20 → 25')).toBeInTheDocument();
    expect(within(dialog).getByText('Fleet reports: No → Yes')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(editor).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.plan_update')!;
    expect(call.path).toBe(`/v1/admin/plans/${fleet20.id}`);
    expect(call.body).toEqual({
      entitlements: [
        { key: 'max_vehicles', value: 25 },
        { key: 'fleet_reports_enabled', value: true },
      ],
      reason: 'planned_change',
    });
  });

  it('assigns a trial to an organization found by name, with an override', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.plans_list': () => page([free, fleet20, providerBasic]),
      'admin.orgs_search': () => page([searchRow(org())]),
      'admin.subscription_assign': () => Response.json(subscription()),
    });
    renderConsole(<PlansPage />, { transport, roles: ['ADM'] });
    const form = await screen.findByTestId('assign-form');
    fireEvent.change(within(form).getByLabelText('Find an organization by name'), { target: { value: 'Tehran' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Find' }));
    fireEvent.click(await within(form).findByLabelText('Tehran Logistics'));
    expect(within(form).getByLabelText('Organization ID')).toHaveValue(ORG);
    expect(calls.find((c) => c.opId === 'admin.orgs_search')!.body).toEqual({ name: 'Tehran', limit: 10 });
    // Only fleet plans for a fleet.
    const planSelect = within(form).getByLabelText('Plan');
    await waitFor(() =>
      expect(
        within(planSelect)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Choose a plan', 'Fleet 20 (Fleets)']),
    );
    fireEvent.change(planSelect, { target: { value: 'fleet_20' } });
    fireEvent.click(within(form).getByLabelText('Trial'));
    const trialEnd = within(form).getByLabelText('Trial ends') as HTMLInputElement;
    expect(trialEnd.value).toBe(dayIn('Asia/Tehran', 30));
    fireEvent.change(trialEnd, { target: { value: '2099-12-10' } });
    fireEvent.click(within(form).getByLabelText('Override Vehicles'));
    fireEvent.change(within(form).getByLabelText('New value for Vehicles'), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start trial' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start this trial' });
    expect(within(dialog).getByText(/Fleet 20 for the Organization/)).toHaveTextContent('Tehran Logistics');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'pilot_operation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start trial' }));
    expect(await screen.findByText("Assigned. The subscriber's limits change at once.")).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.subscription_assign')!.body).toEqual({
      subscriber: { type: 'organization', id: ORG },
      plan_key: 'fleet_20',
      status: 'trial',
      trial_ends_at: '2099-12-10T20:29:59.000Z',
      entitlement_overrides: [{ key: 'max_vehicles', value: 30 }],
      reason: 'pilot_operation',
    });
    expect(screen.getByTestId('assign-result')).toHaveTextContent('Fleet 20 — Trial');
  });

  it('a user from a link: individual plans only; a trial needs its end day; an unknown id is explained', async () => {
    resetNav(`/plans?subscriber=user:${USER}`);
    const { transport, calls } = scriptedTransport({
      'admin.plans_list': () => page([free, fleet20]),
      'admin.subscription_assign': () =>
        Response.json(
          { code: 'REFERENCE_NOT_FOUND', title: 'x', errors: [{ pointer: '/subscriber/id', code: 'reference_not_found' }] },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    renderConsole(<PlansPage />, { transport, roles: ['ADM'] });
    const form = await screen.findByTestId('assign-form');
    expect(within(form).getByLabelText('User')).toBeChecked();
    expect(within(form).getByLabelText('User ID')).toHaveValue(USER);
    const planSelect = within(form).getByLabelText('Plan');
    await waitFor(() => expect(within(planSelect).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(planSelect, { target: { value: 'individual_free' } });
    fireEvent.click(within(form).getByLabelText('Trial'));
    fireEvent.change(within(form).getByLabelText('Trial ends'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start trial' }));
    expect(within(form).getByText('Choose a day after today.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(form).getByLabelText('Active plan'));
    fireEvent.click(within(form).getByRole('button', { name: 'Assign plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign this plan' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'correction' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign plan' }));
    expect(await screen.findByText('No user or organization with this ID can take a plan.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.subscription_assign')!.body).toEqual({
      subscriber: { type: 'user', id: USER },
      plan_key: 'individual_free',
      status: 'active',
      reason: 'correction',
    });
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/plans?plan=${fleet20.id}`);
      const { transport } = scriptedTransport({
        'admin.plans_list': () => page([free, fleet20]),
        'admin.orgs_search': () => page([searchRow(org())]),
      });
      renderConsole(<PlansPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('plan-editor');
      const form = screen.getByTestId('assign-form');
      fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'Tehran' } });
      fireEvent.click(within(form).getAllByRole('button')[0]!);
      await within(form).findByText('Tehran Logistics');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
