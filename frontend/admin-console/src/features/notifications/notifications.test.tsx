// AC14.T3 tests of Notifications & templates and the staff notice bell: templates with flags and filters in the query;
// locked templates read-only; an edit checked for placeholders, previewed, saved with a reason (If-Match only for an
// override) and reset; the rules saved whole with If-Match (odometer prompt sent back as stored); delivery health; the
// bell's unread count, rendered notices and mark read; the pure rules; axe in EN and FA.
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryHealth, Notification, NotificationRules, NotificationTemplate } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { NoticeBell } from '../shell/notice-bell';
import { NotificationsPage } from './notifications-page';
import { parseReminderDays, placeholdersOf, ratePercent, rulesDraftOf, rulesWriteOf, templateWriteOf } from './notif-logic';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const tpl = (o: Partial<NotificationTemplate> = {}): NotificationTemplate => ({
  template_key: 'review.received',
  channel: 'email',
  locale: 'en',
  kind: 'notification',
  always_delivered: false,
  editable: true,
  source: 'code',
  subject: 'New review for {business_name}',
  body: 'Hello {recipient_name}, you have a new review.',
  variables: ['business_name', 'recipient_name'],
  missing_translation: false,
  translation_outdated: false,
  updated_by_display: null,
  updated_at: null,
  version: null,
  ...o,
});

const rules: NotificationRules = {
  review_invitation_delay_minutes: 60,
  review_invitation_reminder_days: [2, 5],
  default_quiet_hours: { start: '22:00', end: '07:00' },
  digest_hour: 8,
  weekly_digest_day: 6,
  review_approval_reminder_days: [3, 6],
  maintenance_due_window_days: 14,
  mileage_due_window_km: 500,
  odometer_prompt_days: 30,
  updated_by_display: null,
  updated_at: new Date().toISOString(),
  version: 4,
};

const reason = (dialog: HTMLElement, code: string) =>
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });

beforeEach(() => resetNav('/notifications'));
afterEach(() => vi.unstubAllGlobals());

describe('notification rules (AC14.T3)', () => {
  it('reads reminder days and placeholders', () => {
    expect(parseReminderDays('2, 5')).toEqual([2, 5]);
    expect(parseReminderDays('۳،۶')).toEqual([3, 6]);
    expect(parseReminderDays('')).toEqual([]);
    expect(parseReminderDays('5, 2')).toBeNull();
    expect(parseReminderDays('1,2,3,4')).toBeNull();
    expect(parseReminderDays('7')).toBeNull();
    expect(placeholdersOf('Hi {a} and {b.c} {a}')).toEqual(['a', 'b.c']);
    expect(ratePercent('0.0423')).toBe(4.2);
    expect(ratePercent(null)).toBeNull();
  });

  it('checks a template text against its channel and placeholders', () => {
    expect(templateWriteOf(tpl(), '', 'x')).toEqual({ problems: ['subject'], unknown: [] });
    expect(templateWriteOf(tpl(), 'Hi', 'Dear {name}')).toEqual({ problems: ['unknown'], unknown: ['name'] });
    expect(templateWriteOf(tpl({ channel: 'sms', subject: null }), 'ignored', 'Code {business_name}')).toEqual({
      value: { channel: 'sms', locale: 'en', body: 'Code {business_name}' },
    });
  });

  it('writes every rule and sends the odometer prompt back unchanged', () => {
    const d = { ...rulesDraftOf(rules), quiet: false, invitationDays: '' };
    expect(rulesWriteOf(rules, d)).toEqual({
      value: {
        review_invitation_delay_minutes: 60,
        review_invitation_reminder_days: [],
        default_quiet_hours: null,
        digest_hour: 8,
        weekly_digest_day: 6,
        review_approval_reminder_days: [3, 6],
        maintenance_due_window_days: 14,
        mileage_due_window_km: 500,
        odometer_prompt_days: 30,
      },
    });
    expect(rulesWriteOf(rules, { ...rulesDraftOf(rules), quietEnd: '22:00', mileageKm: '10' })).toEqual({
      problems: ['quietEnd', 'mileageKm'],
    });
  });
});

describe('Notifications & templates page (AC14.T3)', () => {
  it('lists templates with flags and passes the filters', async () => {
    resetNav('/notifications?channel=email&missing_only=true');
    const { transport, calls } = scriptedTransport({
      'admin.notif_templates_list': () =>
        Response.json({
          items: [
            tpl({ locale: 'fa', missing_translation: true }),
            tpl({ template_key: 'system.security_alert', always_delivered: true, editable: false }),
          ],
        }),
    });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Message templates' });
    expect(await within(table).findByText('Missing translation')).toBeInTheDocument();
    expect(within(table).getByText('Always delivered')).toBeInTheDocument();
    expect(within(table).getByText('Locked')).toBeInTheDocument();
    const q = new URLSearchParams(calls[0]!.search);
    expect(q.get('channel')).toBe('email');
    expect(q.get('missing_only')).toBe('true');
  });

  it('shows a locked template read-only', async () => {
    resetNav('/notifications?template=system.security_alert|email|en');
    const { transport } = scriptedTransport({
      'admin.notif_templates_list': () =>
        Response.json({ items: [tpl({ template_key: 'system.security_alert', kind: 'transactional', editable: false })] }),
    });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('template-editor');
    expect(within(editor).getByTestId('template-locked')).toHaveTextContent('links, codes, invitations');
    expect(within(editor).queryByRole('button', { name: 'Save the text' })).toBeNull();
  });

  it('previews, refuses unknown placeholders and saves a built-in text without If-Match', async () => {
    resetNav('/notifications?template=review.received|email|en');
    const { transport, calls } = scriptedTransport({
      'admin.notif_templates_list': () => Response.json({ items: [tpl()] }),
      'admin.notif_template_preview': () =>
        Response.json({ subject: 'New review for Pars Auto', body: 'Hello Sara, you have a new review!' }),
      'admin.notif_template_update': () => Response.json(tpl({ source: 'override', version: 1 })),
    });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('template-editor');
    expect(within(editor).getByTestId('template-variables')).toHaveTextContent('{business_name}');
    const text = within(editor).getByLabelText('Text');
    fireEvent.change(text, { target: { value: 'Hello {name}' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save the text' }));
    expect(within(editor).getByText('These placeholders are not available here: {name}.')).toBeInTheDocument();
    fireEvent.change(text, { target: { value: 'Hello {recipient_name}, you have a new review!' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview' }));
    expect(await within(editor).findByTestId('template-preview')).toHaveTextContent('Hello Sara, you have a new review!');
    expect(calls.find((c) => c.opId === 'admin.notif_template_preview')!.body).toEqual({
      channel: 'email',
      locale: 'en',
      subject: 'New review for {business_name}',
      body: 'Hello {recipient_name}, you have a new review!',
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save the text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the text of review.received' });
    reason(dialog, 'correction');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the text' }));
    expect(await screen.findByText('Text saved.')).toBeInTheDocument();
    const put = calls.find((c) => c.opId === 'admin.notif_template_update')!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/v1/admin/notification-templates/review.received');
    expect(put.headers.get('if-match')).toBeNull();
    expect(put.body).toEqual({
      channel: 'email',
      locale: 'en',
      subject: 'New review for {business_name}',
      body: 'Hello {recipient_name}, you have a new review!',
      reason: 'correction',
    });
  });

  it('resets a staff text with If-Match', async () => {
    resetNav('/notifications?template=review.received|push|fa');
    const { transport, calls } = scriptedTransport({
      'admin.notif_templates_list': () =>
        Response.json({
          items: [
            tpl({
              channel: 'push',
              locale: 'fa',
              source: 'override',
              version: 3,
              updated_by_display: 'Sara Staff',
              updated_at: new Date().toISOString(),
            }),
          ],
        }),
      'admin.notif_template_reset': () => Response.json(tpl({ channel: 'push', locale: 'fa' })),
    });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('template-editor');
    fireEvent.click(within(editor).getByRole('button', { name: 'Back to the built-in text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use the built-in text of review.received again' });
    reason(dialog, 'correction');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to the built-in text' }));
    expect(await screen.findByText('The built-in text applies again.')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.notif_template_reset')!;
    expect(post.headers.get('if-match')).toBe('"v3"');
    expect(post.body).toEqual({ channel: 'push', locale: 'fa', reason: 'correction' });
  });

  it('saves the rules whole with If-Match', async () => {
    resetNav('/notifications?tab=rules');
    const { transport, calls } = scriptedTransport({
      'admin.notif_rules_get': () => Response.json(rules),
      'admin.notif_rules_update': () => Response.json({ ...rules, version: 5 }),
    });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const form = await screen.findByTestId('notif-rules');
    fireEvent.change(within(form).getByLabelText('Reminders to the customer (days after the invitation)'), { target: { value: '3, 1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the rules' }));
    expect(within(form).getByText('Enter up to three days from 1 to 6, ascending, separated by commas.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Reminders to the customer (days after the invitation)'), { target: { value: '1, 3' } });
    fireEvent.change(within(form).getByLabelText('… or (km before)'), { target: { value: '800' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the rules' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the notification rules' });
    reason(dialog, 'planned_change');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the rules' }));
    expect(await screen.findByText(/Rules saved/)).toBeInTheDocument();
    const put = calls.find((c) => c.opId === 'admin.notif_rules_update')!;
    expect(put.headers.get('if-match')).toBe('"v4"');
    expect(put.body).toMatchObject({
      review_invitation_reminder_days: [1, 3],
      mileage_due_window_km: 800,
      odometer_prompt_days: 30,
      default_quiet_hours: { start: '22:00', end: '07:00' },
      reason: 'planned_change',
    });
  });

  it('shows delivery health per channel and provider', async () => {
    resetNav('/notifications?tab=health');
    const w = (attempted: number, failed: number) => ({
      attempted,
      failed,
      failure_rate: attempted ? (failed / attempted).toFixed(4) : null,
    });
    const health: DeliveryHealth = {
      generated_at: new Date().toISOString(),
      rows: [
        {
          channel: 'email',
          provider: 'smtp',
          last_24h: w(40, 2),
          last_7d: w(300, 6),
          last_30d: w(1200, 12),
          last_failure_at: new Date().toISOString(),
        },
        { channel: 'sms', provider: 'sms_gateway', last_24h: w(0, 0), last_7d: w(0, 0), last_30d: w(10, 0), last_failure_at: null },
      ],
    };
    const { transport } = scriptedTransport({ 'admin.notif_delivery_health': () => Response.json(health) });
    renderConsole(<NotificationsPage />, { transport, roles: ['ADM'] });
    const section = await screen.findByTestId('notif-health');
    const email = within(section).getByText('smtp').closest('tr')!;
    expect(within(email).getByText('5%')).toHaveAttribute('data-high', 'true');
    expect(within(email).getByText('2 of 40 failed', { exact: false })).toBeInTheDocument();
    const sms = within(section).getByText('sms_gateway').closest('tr')!;
    expect(within(sms).getByText('None')).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: templates and rules (${locale})`, async () => {
      resetNav('/notifications?template=review.received|email|en');
      const { transport } = scriptedTransport({
        'admin.notif_templates_list': () => Response.json({ items: [tpl(), tpl({ locale: 'fa', translation_outdated: true })] }),
        'admin.notif_template_preview': () => Response.json({ subject: 'New review for Pars Auto', body: 'Hello Sara' }),
      });
      const view = renderConsole(<NotificationsPage />, { transport, roles: ['ADM'], locale });
      const editor = await screen.findByTestId('template-editor');
      fireEvent.click(within(editor).getByRole('button', { name: locale === 'fa' ? 'پیش‌نمایش' : 'Preview' }));
      await within(editor).findByTestId('template-preview');
      expect(await axeViolations()).toEqual([]);
      view.unmount();
      resetNav('/notifications?tab=rules');
      const r = scriptedTransport({ 'admin.notif_rules_get': () => Response.json(rules) });
      renderConsole(<NotificationsPage />, { transport: r.transport, roles: ['ADM'], locale });
      await screen.findByTestId('notif-rules');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

describe('staff notice bell (AC14.T3, D-79)', () => {
  const notice = (id: string, o: Partial<Notification>): Notification => ({
    id,
    event_type: 'four_eyes_outcome' as Notification['event_type'],
    category: 'system' as Notification['category'],
    priority: 'normal',
    template_key: 'staff.four_eyes_outcome',
    template_params: { op_id: 'admin.retention_update', status: 'approved' },
    locale: 'en',
    organization_context_id: null,
    reference: { type: 'pending_change', id: '0193a3c4-5d6e-7f80-9a1b-0000000000cc' },
    read_at: null,
    created_at: new Date().toISOString(),
    ...o,
  });

  it('shows the unread count, renders notices from the dictionary and marks them read', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.notifications_unread_count': () => Response.json({ count: 2 }),
      'admin.notifications_list': () =>
        page([
          notice('0193a3c4-5d6e-7f80-9a1b-0000000000d1', {}),
          notice('0193a3c4-5d6e-7f80-9a1b-0000000000d2', {
            template_key: 'admin.dsr_deadline',
            template_params: { request_count: 3 },
            reference: null,
          }),
          notice('0193a3c4-5d6e-7f80-9a1b-0000000000d3', {
            template_key: 'staff.new_thing',
            template_params: {},
            read_at: new Date().toISOString(),
          }),
        ]),
      'admin.notifications_mark_read': () => Response.json({ ok: true }),
    });
    renderConsole(<NoticeBell />, { transport, roles: ['ADM'] });
    const bell = await screen.findByRole('button', { name: 'Notices, 2 unread' });
    fireEvent.click(bell);
    const panel = screen.getByTestId('notice-panel');
    const first = await within(panel).findByRole('link', { name: /Your change "Data retention change" was approved/ });
    expect(first).toHaveAttribute('href', '/approvals?change=0193a3c4-5d6e-7f80-9a1b-0000000000cc');
    expect(within(panel).getByText('3 privacy requests are close to their legal deadline.')).toBeInTheDocument();
    expect(within(panel).getByText('A notice this console does not know yet (staff.new_thing).')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    await vi.waitFor(() => expect(calls.some((c) => c.opId === 'admin.notifications_mark_read')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.notifications_mark_read')!.body).toEqual({ up_to: expect.any(String) });
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: the open bell (${locale})`, async () => {
      const { transport } = scriptedTransport({
        'admin.notifications_unread_count': () => Response.json({ count: 1 }),
        'admin.notifications_list': () => page([notice('0193a3c4-5d6e-7f80-9a1b-0000000000d1', {})]),
      });
      renderConsole(<NoticeBell />, { transport, roles: ['ADM'], locale });
      fireEvent.click(await screen.findByTestId('notice-bell'));
      await screen.findAllByTestId('notice');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
