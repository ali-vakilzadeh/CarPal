// AC14.T5 tests of the support inbox: views to the status filter; the ticket read for its own purpose (ticket:<id>)
// with the conversation and the requester's page for the ticket; a templated reply in the chosen language; a
// conversion into a moderation case (severity floor) and its rules; Close with an outcome (converted needs an item);
// Assign to oneself; a ticket the system closed; the team's clock; axe in EN and FA.
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffSupportTicket, StaffSupportTicketDetail } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, staffView } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { SUPPORT_REPLIES } from '@/lib/config/support-replies';
import { conversionOf, EMPTY_CONVERSION, statusesOf, ticketSla } from './support-logic';
import { SupportPage } from './support-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ID = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const USER = '0193a3c4-5d6e-7f80-9a1b-0000000000b1';
const TARGET = '0193a3c4-5d6e-7f80-9a1b-0000000000c1';
const ME = 'staff-1';
const HOUR = 3_600_000;

const row = (o: Partial<StaffSupportTicket> = {}): StaffSupportTicket => ({
  id: ID,
  topic: 'appointment_problem',
  subject: 'The shop did not show up',
  app_area: 'appointments',
  requester: { user_id: USER, display: 'Sara K.' },
  organization: null,
  status: 'new',
  outcome: null,
  assignee: null,
  clock_started_at: new Date(Date.now() - 2 * HOUR).toISOString(),
  first_response_at: null,
  message_count: 1,
  linked_items: [],
  created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
  last_message_at: new Date(Date.now() - 2 * HOUR).toISOString(),
  solved_at: null,
  version: 1,
  ...o,
});

const detail = (o: Partial<StaffSupportTicketDetail> = {}): StaffSupportTicketDetail => ({
  ...row(),
  diagnostics: { platform: 'android', app_version: '1.4.0', os_version: '14' },
  resolution_note: null,
  items: [
    {
      id: '0193a3c4-5d6e-7f80-9a1b-0000000000d1',
      author: 'requester',
      author_display: 'Sara K.',
      body: 'I waited an hour and nobody came.',
      created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      template_key: null,
      staff_author_display: null,
    },
  ],
  ...o,
});

const reason = (dialog: HTMLElement, code: string) =>
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });

function transport(d: StaffSupportTicketDetail = detail(), extra: Parameters<typeof scriptedTransport>[0] = {}) {
  return scriptedTransport({
    'admin.support_tickets_list': () => page([row(d)]),
    'admin.support_ticket_get': () => Response.json(d),
    'admin.staff_list': () => page([]),
    ...extra,
  });
}

beforeEach(() => resetNav('/support'));
afterEach(() => vi.unstubAllGlobals());

describe('support rules (AC14.T5)', () => {
  it('maps views to statuses and stops the clock while waiting on the person', () => {
    expect(statusesOf('open')).toEqual(['new', 'waiting_on_team']);
    expect(statusesOf('all')).toEqual([]);
    expect(ticketSla(row({ status: 'waiting_on_user' }), 'Asia/Tehran')).toBeNull();
    expect(ticketSla(row(), 'Asia/Tehran')!.state).toBe('ok');
  });

  it('builds only the fields a conversion needs; the severity floor', () => {
    expect(
      conversionOf({ ...EMPTY_CONVERSION, into: 'moderation_case', caseTargetType: 'review', caseTargetId: 'x', reason: 'fake' }, false),
    ).toEqual({
      problems: ['target'],
    });
    expect(
      conversionOf(
        {
          ...EMPTY_CONVERSION,
          into: 'moderation_case',
          caseTargetType: 'review',
          caseTargetId: TARGET,
          reason: 'unsafe_advice',
          severity: 'low',
        },
        false,
      ),
    ).toEqual({
      value: { into: 'moderation_case', case_target: { type: 'review', id: TARGET }, moderation_reason: 'unsafe_advice', severity: 'high' },
    });
    expect(conversionOf({ ...EMPTY_CONVERSION, into: 'plan_request', planKey: 'fleet_20' }, false)).toEqual({ problems: ['organization'] });
    expect(conversionOf({ ...EMPTY_CONVERSION, into: 'privacy_request', requestType: 'export', statement: ' Please ' }, false)).toEqual({
      value: { into: 'privacy_request', request_type: 'export', statement: 'Please' },
    });
  });
});

describe('Support inbox (AC14.T5)', () => {
  it('lists the open view and reads a ticket for its own purpose', async () => {
    resetNav(`/support?ticket=${ID}`);
    const { transport: tr, calls } = transport();
    renderConsole(<SupportPage />, { transport: tr, roles: ['SUP'] });
    const table = await screen.findByRole('table', { name: 'Tickets' });
    expect(await within(table).findByText('The shop did not show up')).toBeInTheDocument();
    expect(within(table).getByText('Not assigned')).toBeInTheDocument();
    const list = calls.find((c) => c.opId === 'admin.support_tickets_list')!;
    // One comma-separated value: the backend refuses a repeated parameter.
    expect(new URLSearchParams(list.search).get('status')).toBe('new,waiting_on_team');
    const ticket = await screen.findByTestId('support-ticket');
    expect(within(ticket).getByText('I waited an hour and nobody came.')).toBeInTheDocument();
    expect(within(ticket).getByRole('link', { name: 'Sara K.' })).toHaveAttribute('href', `/users/${USER}?purpose=ticket%3A${ID}`);
    const get = calls.find((c) => c.opId === 'admin.support_ticket_get')!;
    expect(get.headers.get('carpal-access-purpose')).toBe(`ticket:${ID}`);
  });

  it('replies from a template in the chosen language, for the ticket', async () => {
    resetNav(`/support?ticket=${ID}`);
    const { transport: tr, calls } = transport(detail(), {
      'admin.support_ticket_reply': () =>
        Response.json({
          id: 'm2',
          author: 'staff',
          author_display: 'CarPal',
          body: 'x',
          created_at: new Date().toISOString(),
          template_key: 'acknowledgement',
          staff_author_display: 'Sara Staff',
        }),
    });
    renderConsole(<SupportPage />, { transport: tr, roles: ['SUP'] });
    const form = await screen.findByTestId('support-reply');
    expect(within(form).getByLabelText('Message')).toHaveValue(SUPPORT_REPLIES.acknowledgement.en);
    fireEvent.click(within(form).getByLabelText('Persian'));
    expect(within(form).getByLabelText('Message')).toHaveValue(SUPPORT_REPLIES.acknowledgement.fa);
    fireEvent.click(within(form).getByLabelText(/Keep the ticket with the team/));
    fireEvent.click(within(form).getByRole('button', { name: 'Send the reply' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reply to "The shop did not show up"' });
    expect(within(dialog).getByText(/stays with the team/)).toBeInTheDocument();
    reason(dialog, 'user_request');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the reply' }));
    expect(await screen.findByText('Reply sent. The person is notified.')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.support_ticket_reply')!;
    expect(post.headers.get('carpal-access-purpose')).toBe(`ticket:${ID}`);
    expect(post.body).toEqual({
      template_key: 'acknowledgement',
      body: SUPPORT_REPLIES.acknowledgement.fa,
      status: 'waiting_on_team',
      reason: 'user_request',
    });
  });

  it('turns a ticket into a moderation case with the severity floor', async () => {
    resetNav(`/support?ticket=${ID}`);
    const { transport: tr, calls } = transport(detail(), {
      'admin.support_ticket_convert': () => Response.json({ ticket: row(), item: { type: 'moderation_case', id: TARGET } }),
    });
    renderConsole(<SupportPage />, { transport: tr, roles: ['SUP'] });
    const form = await screen.findByTestId('support-convert');
    fireEvent.click(within(form).getByRole('button', { name: 'Turn into a work item' }));
    expect(within(form).getByText('Choose a work item.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Work item'), { target: { value: 'moderation_case' } });
    fireEvent.change(within(form).getByLabelText('What it is about'), { target: { value: 'review' } });
    fireEvent.change(within(form).getByLabelText('Its ID'), { target: { value: TARGET } });
    fireEvent.change(within(form).getByLabelText('Moderation reason'), { target: { value: 'unsafe_advice' } });
    fireEvent.change(within(form).getByLabelText('Severity'), { target: { value: 'low' } });
    expect(within(form).getByText('This reason is handled at least as high severity.')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Turn into a work item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn "The shop did not show up" into a work item' });
    reason(dialog, 'needs_review');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn into a work item' }));
    expect(await screen.findByText('Work item created. It follows its own queue.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.support_ticket_convert')!.body).toEqual({
      into: 'moderation_case',
      case_target: { type: 'review', id: TARGET },
      moderation_reason: 'unsafe_advice',
      severity: 'high',
      reason: 'needs_review',
    });
  });

  it('closes with an outcome; "turned into" needs a linked item; takes the ticket', async () => {
    resetNav(`/support?ticket=${ID}`);
    const { transport: tr, calls } = transport(detail(), {
      'admin.support_ticket_close': () => Response.json(row({ status: 'solved', outcome: 'answered' })),
      'admin.support_ticket_assign': () => Response.json(row({ assignee: { user_id: ME, display: 'Sara Staff' } })),
    });
    renderConsole(<SupportPage />, { transport: tr, session: staffView(['SUP'], { id: ME }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Take it' }));
    let dialog = await screen.findByRole('dialog', { name: 'Assign "The shop did not show up"' });
    reason(dialog, 'taking_over');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Assigned.')).toBeInTheDocument();
    const assign = calls.find((c) => c.opId === 'admin.support_ticket_assign')!;
    expect(assign.body).toEqual({ reason: 'taking_over' });
    expect(assign.headers.get('carpal-access-purpose')).toBeNull();
    const close = await screen.findByTestId('support-close');
    fireEvent.click(within(close).getByLabelText('Turned into a work item'));
    expect(within(close).getByText('"Turned into a work item" needs a linked item first.')).toBeInTheDocument();
    expect(within(close).getByRole('button', { name: 'Close the ticket' })).toBeDisabled();
    fireEvent.click(within(close).getByLabelText('Answered'));
    fireEvent.change(within(close).getByLabelText('Internal note (optional)'), { target: { value: 'Shop apologised.' } });
    const readsBeforeClose = calls.filter((c) => c.opId === 'admin.support_ticket_get').length;
    fireEvent.click(within(close).getByRole('button', { name: 'Close the ticket' }));
    dialog = await screen.findByRole('dialog', { name: 'Close "The shop did not show up"' });
    reason(dialog, 'action_completed');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the ticket' }));
    expect(await screen.findByText('Ticket solved. The person is notified.')).toBeInTheDocument();
    expect(await screen.findByTestId('support-ticket')).toHaveAttribute('data-status', 'solved');
    // No read after Close (the purpose is closed): the answer keeps the ticket.
    expect(calls.filter((c) => c.opId === 'admin.support_ticket_get')).toHaveLength(readsBeforeClose);
    expect(calls.find((c) => c.opId === 'admin.support_ticket_close')!.body).toEqual({
      outcome: 'answered',
      resolution_note: 'Shop apologised.',
      reason: 'action_completed',
    });
  });

  it('shows a ticket the system closed from its row, without reading it (the purpose is closed)', async () => {
    resetNav(`/support?view=solved&ticket=${ID}`);
    const solved = row({ status: 'solved', outcome: 'no_response', solved_at: new Date().toISOString(), clock_started_at: null });
    const { transport: tr, calls } = scriptedTransport({
      'admin.support_tickets_list': () => page([solved]),
      'admin.staff_list': () => page([]),
    });
    renderConsole(<SupportPage />, { transport: tr, roles: ['ADM'] });
    expect(await screen.findByTestId('support-outcome')).toHaveTextContent('No response');
    expect(screen.getByTestId('support-outcome')).toHaveTextContent('closed by the system');
    expect(screen.getByTestId('support-solved-note')).toBeInTheDocument();
    expect(screen.queryByTestId('support-close')).toBeNull();
    expect(calls.some((c) => c.opId === 'admin.support_ticket_get')).toBe(false);
  });

  it('says a refused read cannot be opened (solved meanwhile, or a colleague has it)', async () => {
    resetNav(`/support?ticket=${ID}`);
    const { transport: tr } = scriptedTransport({
      'admin.support_tickets_list': () => page([]),
      'admin.support_ticket_get': () => Response.json({ code: 'NOT_FOUND', title: 'not open' }, { status: 404 }),
      'admin.staff_list': () => page([]),
    });
    renderConsole(<SupportPage />, { transport: tr, roles: ['SUP'] });
    expect(await screen.findByTestId('support-not-open')).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/support?ticket=${ID}`);
      const { transport: tr } = transport(detail({ linked_items: [{ type: 'dispute', id: TARGET }] }));
      renderConsole(<SupportPage />, { transport: tr, roles: ['ADM'], locale });
      await screen.findByTestId('support-ticket');
      await screen.findByTestId('support-reply');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
