// AC13.T2/T3 tests of MCP clients and the access log: the catalog tree (unknown values under Other, kept on save),
// a scope change sent with only the changed list and the version as If-Match and waiting for a second admin (202),
// a suspension applied at once, a reactivation that waits, and the audited log search that runs only on Search
// with masked principals; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAccessLogView, McpClientView, PendingChange } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { accessChanges, catalogTree, domainOf, draftOf, statusAction } from './mcp-logic';
import { McpPage } from './mcp-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ID = '0193a3c4-5d6e-7f80-9a1b-00000000c001';
const USER = '0193a3c4-5d6e-7f80-9a1b-0000000a11ce';

const client = (o: Partial<McpClientView> = {}): McpClientView => ({
  id: ID,
  name: 'admin_copilot',
  client_type: 'internal_assistant',
  allowed_scopes: ['read:audit.log:staff'],
  allowed_resources: ['res:audit.log', 'res:feature.flags'],
  allowed_tools: ['tool:taxonomy.suggest_synonym@1', 'tool:custom.experiment@2'],
  rate_limit_policy: 'mcp.staff',
  geo_restrictions: [],
  environment: 'dev',
  status: 'active',
  version: 3,
  ...o,
});

const pending = (summary: string): PendingChange => ({
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000cc',
  op_id: 'admin.mcp_client_update',
  summary,
  requested_by_display: 'Sara Admin',
  requested_at: new Date().toISOString(),
  reason: 'least_privilege',
  status: 'pending',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
});

beforeEach(() => resetNav('/mcp'));
afterEach(() => vi.unstubAllGlobals());

describe('MCP rules (AC13.T2)', () => {
  it('groups by domain and keeps unknown values under Other', () => {
    expect(domainOf('read:vehicle.summary:owned')).toBe('vehicle');
    expect(domainOf('res:taxonomy.vehicle.brands')).toBe('taxonomy');
    expect(domainOf('tool:triage.classify_symptom@1')).toBe('triage');
    const tree = catalogTree('allowed_tools', ['tool:custom.experiment@2', 'tool:triage.start@1']);
    expect(tree.at(-1)).toEqual({ domain: null, values: ['tool:custom.experiment@2'] });
    expect(tree.find((g) => g.domain === 'triage')!.values).toContain('tool:triage.start@1');
  });

  it('sends only the changed lists, each whole, and never a status with them', () => {
    const c = client();
    const d = draftOf(c);
    expect(accessChanges(c, d).diff).toEqual([]);
    d.allowed_tools = d.allowed_tools.filter((v) => v !== 'tool:taxonomy.suggest_synonym@1');
    const { body, diff } = accessChanges(c, d);
    expect(body).toEqual({ allowed_tools: ['tool:custom.experiment@2'] });
    expect(diff).toEqual([{ field: 'allowed_tools', added: [], removed: ['tool:taxonomy.suggest_synonym@1'] }]);
    expect(statusAction('active')).toBe('suspend');
    expect(statusAction('suspended')).toBe('reactivate');
    expect(statusAction('revoked')).toBeNull();
  });
});

describe('MCP clients (AC13.T2)', () => {
  it('a tool removed: only the tools list, with If-Match, waits for a second admin', async () => {
    resetNav(`/mcp?client=${ID}`);
    const { transport, calls } = scriptedTransport({
      'admin.mcp_clients_list': () => page([client()]),
      'admin.mcp_client_update': () => Response.json(pending('MCP client admin_copilot: allowed_tools (1)'), { status: 202 }),
    });
    renderConsole(<McpPage />, { transport, roles: ['ADM'] });
    const detail = await screen.findByTestId('mcp-client');
    const tools = detail.querySelector('[data-field="allowed_tools"]') as HTMLElement;
    // The unknown tool is listed under Other and stays ticked.
    expect(within(tools).getByText('Other (not in the catalog)')).toBeInTheDocument();
    expect(within(tools).getByRole('checkbox', { name: 'tool:custom.experiment@2' })).toBeChecked();
    expect(within(detail).getByRole('button', { name: 'Ask to save' })).toBeDisabled();
    fireEvent.click(within(tools).getByRole('checkbox', { name: 'tool:taxonomy.suggest_synonym@1' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Ask to save' }));
    const dialog = await screen.findByRole('dialog', { name: "Change the client's access" });
    expect(within(dialog).getByTestId('mcp-diff')).toHaveTextContent('Removed: tool:taxonomy.suggest_synonym@1');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'least_privilege' } });
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: 'Not used by the copilot' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(await screen.findByText(/Waiting for a second/)).toBeInTheDocument();
    const patch = calls.find((c) => c.opId === 'admin.mcp_client_update')!;
    expect(patch.method).toBe('PATCH');
    expect(patch.path).toBe(`/v1/admin/mcp/clients/${ID}`);
    expect(patch.headers.get('if-match')).toBe('"v3"');
    expect(patch.body).toEqual({ allowed_tools: ['tool:custom.experiment@2'], reason: 'least_privilege: Not used by the copilot' });
    // The editor starts again from the client's current lists.
    await waitFor(() =>
      expect(within(screen.getByTestId('mcp-client')).getByRole('checkbox', { name: 'tool:taxonomy.suggest_synonym@1' })).toBeChecked(),
    );
  });

  it('suspend applies at once; a suspended client asks a second admin to reactivate', async () => {
    resetNav(`/mcp?client=${ID}`);
    let current = client();
    const { transport, calls } = scriptedTransport({
      'admin.mcp_clients_list': () => page([current]),
      'admin.mcp_client_update': (_req, body) => {
        if (body?.status === 'suspended') {
          current = client({ status: 'suspended', version: 4 });
          return Response.json(current);
        }
        return Response.json(pending('MCP client admin_copilot: status active'), { status: 202 });
      },
    });
    renderConsole(<McpPage />, { transport, roles: ['ADM'] });
    const status = await screen.findByTestId('mcp-status');
    fireEvent.click(within(status).getByRole('button', { name: 'Suspend' }));
    let dialog = await screen.findByRole('dialog', { name: 'Suspend the client' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'incident_response' } });
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: 'Unexpected tool calls' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await within(status).findByText('The client was updated.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.mcp_client_update')!.body).toEqual({
      status: 'suspended',
      reason: 'incident_response: Unexpected tool calls',
    });
    const button = await within(screen.getByTestId('mcp-status')).findByRole('button', { name: 'Ask to reactivate' });
    fireEvent.click(button);
    dialog = await screen.findByRole('dialog', { name: 'Reactivate the client' });
    expect(within(dialog).getByText(/second platform admin must approve/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'incident_resolved' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(await screen.findByText(/Waiting for a second/)).toBeInTheDocument();
    const last = calls.filter((c) => c.opId === 'admin.mcp_client_update').at(-1)!;
    expect(last.body).toEqual({ status: 'active', reason: 'incident_resolved' });
    expect(last.headers.get('if-match')).toBe('"v4"');
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/mcp?client=${ID}`);
      const { transport } = scriptedTransport({
        'admin.mcp_clients_list': () => page([client(), client({ id: `${ID.slice(0, -1)}2`, name: 'ai_pipelines', status: 'suspended' })]),
      });
      renderConsole(<McpPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('mcp-client');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

const entry = (o: Partial<McpAccessLogView> = {}): McpAccessLogView => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000001a9',
  mcp_client_id: ID,
  principal: { type: 'user', id: USER },
  organization_id: null,
  operation_type: 'tool_invoke',
  resource_or_tool_key: 'tool:triage.classify_symptom',
  tool_version: '1',
  risk_level: 'personalized_read',
  consent_reference_id: '0193a3c4-5d6e-7f80-9a1b-0000000000c0',
  redactions_applied: [],
  policy_decision: 'denied',
  approval_request_id: null,
  output_insight_id: '0193a3c4-5d6e-7f80-9a1b-0000000001b0',
  model_version: 'stub-1',
  result_status: 'failure',
  latency_ms: 42,
  request_id: 'req-9',
  created_at: new Date().toISOString(),
  ...o,
});

describe('MCP access log (AC13.T3)', () => {
  it('searches only when asked, with the filters and a window; principals masked', async () => {
    resetNav('/mcp?tab=log');
    const { transport, calls } = scriptedTransport({
      'admin.mcp_clients_list': () => page([client()]),
      'admin.mcp_access_log_search': () => page([entry()]),
    });
    renderConsole(<McpPage />, { transport, roles: ['ADM'] });
    const log = await screen.findByTestId('mcp-log');
    expect(within(log).getByTestId('mcp-log-idle')).toBeInTheDocument();
    await waitFor(() => expect(within(log).getByRole('option', { name: 'admin_copilot' })).toBeInTheDocument());
    expect(calls.filter((c) => c.opId === 'admin.mcp_access_log_search')).toHaveLength(0);
    fireEvent.change(within(log).getByLabelText('Client'), { target: { value: ID } });
    fireEvent.change(within(log).getByLabelText('Decision'), { target: { value: 'denied' } });
    fireEvent.change(within(log).getByLabelText('User or organization ID'), { target: { value: 'abc' } });
    fireEvent.click(within(log).getByRole('button', { name: 'Search' }));
    expect(await within(log).findByText(/Enter a full ID/)).toBeInTheDocument();
    fireEvent.change(within(log).getByLabelText('User or organization ID'), { target: { value: USER } });
    fireEvent.click(within(log).getByRole('button', { name: 'Search' }));
    const results = await screen.findByTestId('mcp-log-results');
    await waitFor(() => expect(within(results).getByText('tool:triage.classify_symptom')).toBeInTheDocument());
    const search = calls.find((c) => c.opId === 'admin.mcp_access_log_search')!;
    expect(search.body).toMatchObject({ mcp_client_id: ID, policy_decision: 'denied', principal_id: USER, limit: 50 });
    const b = search.body as { from: string; to: string };
    expect(Date.parse(b.to) - Date.parse(b.from)).toBe(7 * 86_400_000);
    // The principal is masked (last 4 characters only); the output links to AI oversight.
    expect(results).not.toHaveTextContent(USER);
    expect(results.querySelector('tbody tr')).toHaveTextContent(/User\s*\S*11ce/);
    expect(within(results).getByRole('link', { name: 'Open the output' }).getAttribute('href')).toMatch(/^\/ai\?tab=insights&insight=/);
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/mcp?tab=log&window=7&at=${Date.now()}`);
      const { transport } = scriptedTransport({
        'admin.mcp_clients_list': () => page([client()]),
        'admin.mcp_access_log_search': () =>
          page([entry(), entry({ id: '0193a3c4-5d6e-7f80-9a1b-0000000001aa', policy_decision: 'allowed', output_insight_id: null })]),
      });
      renderConsole(<McpPage />, { transport, roles: ['ADM'], locale });
      const results = await screen.findByTestId('mcp-log-results');
      await waitFor(() => expect(results.querySelectorAll('tbody tr')).toHaveLength(2));
      expect(await axeViolations()).toEqual([]);
    });
  }
});
