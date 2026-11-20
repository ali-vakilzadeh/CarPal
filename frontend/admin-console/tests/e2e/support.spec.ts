// AC14.T6 E2E for AC14-2's support inbox (A-SUP-01) against the live backend (strict for the acceptance run). Each test
// files its own tickets from a new app user (tests/e2e/app-user.ts); nothing else in the shared database changes.
//   EN  a support agent finds the new ticket in the open view, reads it for its purpose (the app's details, the
//       conversation), takes it, sends an acknowledgement that keeps it with the team, turns it into a privacy request
//       (the linked item) and closes it as turned into; the requester sees the reply from "CarPal" and the ticket
//       solved. Axe on the list and the ticket.
//   FA  a support agent answers a second ticket in Persian from a template and closes it as answered. Axe in FA.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appUser, fileTicket, ticketThread } from './app-user';
import { requireBackend, signInAs } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

test.beforeAll(requireBackend);
test.describe.configure({ timeout: 300_000 });

async function confirmWith(page: Page, l: 'en' | 'fa', title: string, confirm: string, code: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('a ticket taken, acknowledged, turned into a privacy request and closed; the requester sees it (EN)', async ({ context, page }) => {
  const user = await appUser('e2e-sup', 'Sara Example');
  const subject = `E2E data question ${Date.now()}`;
  const id = await fileTicket(user, { topic: 'data', subject, body: 'Please send me a copy of everything you store about me.' });
  await signInAs(context, page, ['SUP'], { path: '/support' });
  await expect(page.getByRole('heading', { level: 1, name: 'Support inbox' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Tickets' })).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);

  await gotoReady(page, `/support?ticket=${id}`);
  const ticket = page.getByTestId('support-ticket');
  await expect(ticket).toHaveAttribute('data-status', 'new', { timeout: 30_000 });
  await expect(ticket.getByText('Please send me a copy of everything you store about me.')).toBeVisible();
  await expect(ticket).toContainText('web_pwa');
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Take it' }).click();
  await confirmWith(page, 'en', `Assign "${subject}"`, 'Assign', 'taking_over');
  await expect(page.getByText('Assigned.')).toBeVisible({ timeout: 30_000 });

  const reply = page.getByTestId('support-reply');
  await reply.getByLabel(/Keep the ticket with the team/).check();
  await reply.getByRole('button', { name: 'Send the reply' }).click();
  await confirmWith(page, 'en', `Reply to "${subject}"`, 'Send the reply', 'user_request');
  await expect(page.getByText('Reply sent. The person is notified.')).toBeVisible({ timeout: 30_000 });

  const convert = page.getByTestId('support-convert');
  await convert.getByLabel('Work item').selectOption('privacy_request');
  await convert.getByLabel('Request type').selectOption('export');
  await convert.getByRole('button', { name: 'Turn into a work item' }).click();
  await confirmWith(page, 'en', `Turn "${subject}" into a work item`, 'Turn into a work item', 'user_request');
  await expect(page.getByText('Work item created. It follows its own queue.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('support-linked')).toContainText('Privacy request', { timeout: 30_000 });

  const close = page.getByTestId('support-close');
  await close.getByLabel('Turned into a work item').check();
  await close.getByRole('button', { name: 'Close the ticket' }).click();
  await confirmWith(page, 'en', `Close "${subject}"`, 'Close the ticket', 'action_completed');
  await expect(page.getByText('Ticket solved. The person is notified.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('support-ticket')).toHaveAttribute('data-status', 'solved', { timeout: 30_000 });

  // The requester's side: the reply is from CarPal (never the staff name) and the ticket is solved.
  const thread = (await ticketThread(user, id)) as { status: string; items: { author: string; author_display: string }[] };
  expect(thread.status).toBe('solved');
  const staffMessages = thread.items.filter((m) => m.author === 'staff');
  expect(staffMessages.length).toBeGreaterThan(0);
  expect(staffMessages.every((m) => m.author_display === 'CarPal')).toBe(true);
});

test('Persian: a ticket answered from a template and closed as answered', async ({ browser }) => {
  const user = await appUser('e2e-sup-fa', 'Sara Nemooneh');
  const subject = `E2E question ${Date.now()}`;
  const id = await fileTicket(user, { topic: 'other', subject, body: 'How can I change the language of the app?' });
  const ctx = await browser.newContext({ locale: 'fa-IR' });
  const page = await ctx.newPage();
  await signInAs(ctx, page, ['SUP'], { path: `/support?ticket=${id}`, locale: 'fa' });
  await expect(page.getByTestId('support-ticket')).toHaveAttribute('data-status', 'new', { timeout: 30_000 });
  await expectNoAxeViolations(page);

  const reply = page.getByTestId('support-reply');
  await reply.getByLabel(say('fa', 'support.reply.template')).selectOption('how_to');
  await expect(reply.getByLabel(say('fa', 'support.reply.body'))).not.toHaveValue('');
  await reply.getByLabel(say('fa', 'support.reply.body')).fill('Settings > Language. (AC14 E2E)');
  await reply.getByRole('button', { name: say('fa', 'support.reply.send') }).click();
  await confirmWith(page, 'fa', say('fa', 'support.dialog.reply', { subject }), say('fa', 'support.reply.send'), 'user_request');
  await expect(page.getByText(say('fa', 'support.reply.sent'))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('support-ticket')).toHaveAttribute('data-status', 'waiting_on_user', { timeout: 30_000 });

  const close = page.getByTestId('support-close');
  await close.getByLabel(say('fa', 'support.outcome.answered')).check();
  await close.getByRole('button', { name: say('fa', 'support.close.submit') }).click();
  await confirmWith(page, 'fa', say('fa', 'support.dialog.close', { subject }), say('fa', 'support.close.submit'), 'action_completed');
  await expect(page.getByTestId('support-ticket')).toHaveAttribute('data-status', 'solved', { timeout: 30_000 });
  await expectNoAxeViolations(page);
  await ctx.close();
});
