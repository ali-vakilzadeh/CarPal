// AC6.T2 tests of Feature flags: the targeting draft and the four-eyes cases (as the server applies them), and the
// screen: the kill switch on top (on: reason + immediate; off: four-eyes banner), a flag switched with its version as
// If-Match, featured.enabled's MVP note, targeting edited and sent, a change made meanwhile (412) explained with a
// Reload that keeps the edit, unknown types; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFlag, PendingChange } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { draftOf, needsSecondApprover, sameTargeting, targetingOf } from './flag-logic';
import { FlagsPage } from './flags-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ORG = '0193a3c4-5d6e-7f80-9a1b-0000000000b1';

function flag(key: string, o: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key,
    description: `About ${key}`,
    flag_type: key.startsWith('ai.') ? 'ai_feature' : 'release',
    enabled: true,
    targeting: null,
    environment: 'dev',
    updated_by_display: 'Ali Admin',
    updated_at: '2026-11-01T08:00:00Z',
    version: 2,
    ...o,
  };
}

const KILL = (enabled: boolean, version = 7) =>
  flag('ai.automation.kill_switch', { flag_type: 'kill_switch', enabled, version, description: 'Stops every AI feature' });

const pendingChange = (summary: string): PendingChange => ({
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000cc',
  op_id: 'admin.flag_update',
  summary,
  requested_by_display: 'Sara Staff',
  requested_at: new Date().toISOString(),
  reason: 'planned_change',
  status: 'pending',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
});

/** flags_list answering per flag_type, like the server. */
function flagsList(all: () => FeatureFlag[]) {
  return (req: { search: string }) => {
    const type = new URLSearchParams(req.search).get('flag_type');
    return page(all().filter((f) => !type || f.flag_type === type));
  };
}

beforeEach(() => resetNav('/flags'));
afterEach(() => vi.unstubAllGlobals());

describe('flag rules (AC6.T2)', () => {
  it('four-eyes: kill switch off and featured.enabled on only', () => {
    expect(needsSecondApprover('ai.automation.kill_switch', false, true)).toBe(false);
    expect(needsSecondApprover('ai.automation.kill_switch', true, false)).toBe(true);
    expect(needsSecondApprover('featured.enabled', false, true)).toBe(true);
    expect(needsSecondApprover('featured.enabled', true, false)).toBe(false);
    expect(needsSecondApprover('map.enabled', true, false)).toBe(false);
  });

  it('turns a draft into the contract targeting (null for everyone) and finds mistakes', () => {
    expect(targetingOf(draftOf(null))).toEqual({ value: null });
    expect(
      targetingOf({
        roles: ['fleet_owner'],
        regions: 'ir, ae ،IR',
        organizationIds: `${ORG}\n${ORG.toUpperCase()}`,
        planKeys: ['fleet_20'],
        percentage: '۲۵',
      }),
    ).toEqual({
      value: { roles: ['fleet_owner'], regions: ['IR', 'AE'], organization_ids: [ORG], plan_keys: ['fleet_20'], percentage: 25 },
    });
    expect(targetingOf({ ...draftOf(null), regions: 'Iran' })).toEqual({ problems: { regions: 'format' } });
    expect(targetingOf({ ...draftOf(null), organizationIds: 'abc' })).toEqual({ problems: { organizationIds: 'format' } });
    expect(targetingOf({ ...draftOf(null), percentage: '101' })).toEqual({ problems: { percentage: 'format' } });
    expect(sameTargeting(null, {})).toBe(true);
    expect(sameTargeting({ regions: ['IR', 'AE'] }, { regions: ['AE', 'IR'] })).toBe(true);
    expect(sameTargeting({ percentage: 10 }, null)).toBe(false);
  });
});

describe('Feature flags page (AC6.T2)', () => {
  it('kill switch on: reason and confirmation, sent at once with the version', async () => {
    let kill = KILL(false);
    const { transport, calls } = scriptedTransport({
      'admin.flags_list': flagsList(() => [kill, flag('map.enabled')]),
      'admin.flag_update': (_req, body) => {
        kill = KILL(body?.enabled === true, 8);
        return Response.json(kill);
      },
    });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    const panel = await screen.findByTestId('kill-switch');
    expect(await within(panel).findByTestId('kill-state')).toHaveTextContent('Off: AI runs');
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop all AI features' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop all AI features' });
    expect(within(dialog).getByText(/takes effect at once for everybody/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all AI features' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'incident_response' } });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Model returns unsafe text' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all AI features' }));
    expect(await within(panel).findByText('Saved. Apps follow within one configuration refresh.')).toBeInTheDocument();
    const patch = calls.find((c) => c.opId === 'admin.flag_update')!;
    expect(patch.method).toBe('PATCH');
    expect(patch.path).toBe('/v1/admin/flags/ai.automation.kill_switch');
    expect(patch.headers.get('if-match')).toBe('"v7"');
    expect(patch.body).toEqual({ enabled: true, reason: 'incident_response: Model returns unsafe text' });
    await waitFor(() => expect(within(panel).getByTestId('kill-state')).toHaveTextContent('On: AI is stopped'));
  });

  it('kill switch off: the second admin rule is said before, and the change waits', async () => {
    const { transport } = scriptedTransport({
      'admin.flags_list': flagsList(() => [KILL(true)]),
      'admin.flag_update': () => Response.json(pendingChange('Turn ai.automation.kill_switch off'), { status: 202 }),
    });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    const panel = await screen.findByTestId('kill-switch');
    expect(await within(panel).findByText('Turning AI back on needs a second platform admin.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn AI back on' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn this flag off' });
    expect(within(dialog).getByText(/A second platform admin must approve this change/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(panel).findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(within(panel).getByText('Turn ai.automation.kill_switch off')).toBeInTheDocument();
  });

  it('a flag is switched from the table; featured.enabled carries the MVP note', async () => {
    resetNav('/flags?flag=featured.enabled');
    const { transport, calls } = scriptedTransport({
      'admin.flags_list': flagsList(() => [KILL(false), flag('featured.enabled', { enabled: false, version: 4 }), flag('map.enabled')]),
      'admin.flag_update': () => Response.json(pendingChange('Turn featured.enabled on'), { status: 202 }),
    });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    const sw = await screen.findByTestId('flag-switch');
    expect(within(sw).getByText('Not part of the MVP')).toBeInTheDocument();
    fireEvent.click(within(sw).getByRole('button', { name: 'Turn on' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn this flag on' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'pilot_operation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Waiting for a second staff member')).toBeInTheDocument();
    const patch = calls.find((c) => c.opId === 'admin.flag_update')!;
    expect(patch.headers.get('if-match')).toBe('"v4"');
    expect(patch.body).toEqual({ enabled: true, reason: 'pilot_operation' });
    // Choosing another row puts it in the URL.
    fireEvent.click(within(screen.getByRole('table', { name: 'Flags' })).getByRole('button', { name: 'map.enabled' }));
    expect(nav.search).toBe('flag=map.enabled');
  });

  it('targeting is edited and sent; a change made meanwhile is explained and Reload keeps the edit', async () => {
    resetNav('/flags?flag=map.enabled');
    let version = 2;
    let answer: () => Response = () => problem(412, 'VERSION_MISMATCH');
    const { transport, calls } = scriptedTransport({
      'admin.flags_list': flagsList(() => [KILL(false), flag('map.enabled', { version })]),
      'admin.flag_update': () => answer(),
    });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    const detail = await screen.findByTestId('flag-detail');
    expect(within(detail).getByTestId('flag-targeting')).toHaveTextContent('Everyone');
    expect(within(detail).getByRole('button', { name: 'Save targeting' })).toBeDisabled();
    fireEvent.click(within(detail).getByLabelText('Fleet owner'));
    fireEvent.change(within(detail).getByLabelText('Regions'), { target: { value: 'ir' } });
    fireEvent.change(within(detail).getByLabelText('Share of users (%)'), { target: { value: '50' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Save targeting' }));
    let dialog = await screen.findByRole('dialog', { name: 'Change the targeting' });
    expect(within(dialog).getByText('New targeting: Roles: Fleet owner · Regions: IR · 50 % of users')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone changed this record meanwhile/)).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.flag_update')!.body).toEqual({
      targeting: { roles: ['fleet_owner'], regions: ['IR'], percentage: 50 },
      reason: 'planned_change',
    });
    // Reload: the new version is read, the edit stays, and the next save sends the new version.
    version = 3;
    answer = () =>
      Response.json(flag('map.enabled', { version: 4, targeting: { roles: ['fleet_owner'], regions: ['IR'], percentage: 50 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((c) => c.opId === 'admin.flags_list').length).toBeGreaterThan(2));
    expect(within(screen.getByTestId('flag-detail')).getByLabelText('Regions')).toHaveValue('ir');
    fireEvent.click(within(screen.getByTestId('flag-detail')).getByRole('button', { name: 'Save targeting' }));
    dialog = await screen.findByRole('dialog', { name: 'Change the targeting' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Apps follow within one configuration refresh.')).toBeInTheDocument();
    expect(
      calls
        .filter((c) => c.opId === 'admin.flag_update')
        .at(-1)!
        .headers.get('if-match'),
    ).toBe('"v3"');
  });

  it('shows mistakes in the targeting and sends nothing', async () => {
    resetNav('/flags?flag=map.enabled');
    const { transport, calls } = scriptedTransport({ 'admin.flags_list': flagsList(() => [KILL(false), flag('map.enabled')]) });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    const detail = await screen.findByTestId('flag-detail');
    fireEvent.change(within(detail).getByLabelText('Organization IDs'), { target: { value: 'not-an-id' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Save targeting' }));
    expect(within(detail).getByText('Each line must be one organization ID.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.opId === 'admin.flag_update')).toBe(false);
  });

  it('unknown flag types and a missing kill switch do not break the page', async () => {
    const { transport } = scriptedTransport({
      'admin.flags_list': (req) =>
        new URLSearchParams(req.search).get('flag_type')
          ? page([])
          : page([flag('x.future', { flag_type: 'experiment' as FeatureFlag['flag_type'] })]),
    });
    renderConsole(<FlagsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('Unknown (experiment)')).toBeInTheDocument();
    expect(await screen.findByText(/kill switch flag does not exist/)).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav('/flags?flag=featured.enabled');
      const { transport } = scriptedTransport({
        'admin.flags_list': flagsList(() => [
          KILL(true),
          flag('featured.enabled', { enabled: false }),
          flag('map.enabled', { targeting: { regions: ['IR'] } }),
        ]),
      });
      renderConsole(<FlagsPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('flag-detail');
      await screen.findByTestId('kill-state');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
