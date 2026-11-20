// AC14.T4 tests of Policies & consent texts: documents with the version in force; published versions read-only; a
// new version starts from the newest texts and needs a label and both locales; a draft is saved with If-Match and only
// the changed fields; publishing asks for the effective time, the re-consent flag and — for a consent text only — keep
// or pause, and is filed for a second admin; the pure rules (zoned time, summary, publish body); axe in EN and FA.
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange, StaffPolicyDocument, StaffPolicyVersion, StaffPolicyVersionSummary } from '@carpal/api-contracts';
import { axeViolations, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { PoliciesPage } from './policies-page';
import { draftOf, patchOf, publishOf, writeOf, zonedIso } from './policy-logic';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const V_PUB = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const V_DRAFT = '0193a3c4-5d6e-7f80-9a1b-0000000000a2';
const V_CONSENT = '0193a3c4-5d6e-7f80-9a1b-0000000000a3';
const V_CDRAFT = '0193a3c4-5d6e-7f80-9a1b-0000000000a4';
const V_NEW = '0193a3c4-5d6e-7f80-9a1b-0000000000a5';
const DAY = 86_400_000;

const summary = (id: string, o: Partial<StaffPolicyVersionSummary> = {}): StaffPolicyVersionSummary => ({
  id,
  policy_key: 'terms',
  policy_version: '1.0',
  status: 'published',
  title: { text: 'User Agreement', locale: 'en' },
  effective_at: new Date(Date.now() - 30 * DAY).toISOString(),
  requires_reconsent: false,
  reconsent_action: null,
  locales: ['en', 'fa'],
  created_by_display: 'Sara Staff',
  created_at: new Date(Date.now() - 40 * DAY).toISOString(),
  published_by_display: null,
  approved_by_display: null,
  published_at: new Date(Date.now() - 30 * DAY).toISOString(),
  ...o,
});

const full = (s: StaffPolicyVersionSummary, o: Partial<StaffPolicyVersion> = {}): StaffPolicyVersion => ({
  ...s,
  title_translations: { en: 'User Agreement', fa: 'توافق‌نامه کاربری' },
  body_translations: { en: '# Terms\n\nUse CarPal fairly.', fa: '# شرایط\n\nمنصفانه استفاده کنید.' },
  change_summary_translations: null,
  version: 3,
  ...o,
});

const pub = summary(V_PUB);
const draft = summary(V_DRAFT, { policy_version: '1.1', status: 'draft', effective_at: null, published_at: null });
const cpub = summary(V_CONSENT, { policy_key: 'marketing', title: { text: 'Marketing messages', locale: 'en' } });
const cdraft = summary(V_CDRAFT, {
  policy_key: 'marketing',
  policy_version: '2.0',
  status: 'draft',
  effective_at: null,
  published_at: null,
});

const docs: StaffPolicyDocument[] = [
  { policy_key: 'terms', region_key: 'IR', reconsent_mode: 'blocking', versions: [draft, pub] },
  { policy_key: 'marketing', region_key: 'IR', reconsent_mode: 'consent', versions: [cdraft, cpub] },
  { policy_key: 'cookies' as StaffPolicyDocument['policy_key'], region_key: 'IR', reconsent_mode: 'notice', versions: [] },
];

const pending: PendingChange = {
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000bb',
  op_id: 'admin.policy_version_publish',
  summary: 'Publish Marketing 2.0',
  requested_by_display: 'Sara Staff',
  requested_at: new Date().toISOString(),
  reason: 'legal_update: yearly review',
  status: 'pending',
  expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
};

const versions: Record<string, StaffPolicyVersion> = {
  [V_PUB]: full(pub),
  [V_DRAFT]: full(draft, { version: 7, body_translations: { en: '# Terms\n\nDraft.', fa: '# شرایط\n\nپیش‌نویس.' } }),
  [V_CONSENT]: full(cpub, { title_translations: { en: 'Marketing messages', fa: 'پیام‌های تبلیغاتی' } }),
  [V_CDRAFT]: full(cdraft, { title_translations: { en: 'Marketing messages', fa: 'پیام‌های تبلیغاتی' } }),
};

function transport(extra: Parameters<typeof scriptedTransport>[0] = {}) {
  return scriptedTransport({
    'admin.policies_list': () => Response.json({ items: docs }),
    'admin.policy_version_get': (req) => {
      const id = req.path.split('/').pop()!;
      const v = versions[id];
      return v ? Response.json(v, { headers: { etag: `"v${v.version}"` } }) : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    },
    ...extra,
  });
}

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => resetNav('/policies'));
afterEach(() => vi.unstubAllGlobals());

describe('policy rules (AC14.T4)', () => {
  it('reads a day and time on the staff clock', () => {
    expect(zonedIso('2026-12-01', '09:30', 'Asia/Tehran')).toBe('2026-12-01T06:00:00.000Z');
    expect(zonedIso('۲۰۲۶-۱۲-۰۱', '۰۹:۳۰', 'Asia/Tehran')).toBe('2026-12-01T06:00:00.000Z');
    expect(zonedIso('2026-12-01', '25:00', 'Asia/Tehran')).toBeNull();
  });

  it('needs a label and both locales, and sends only the summaries that exist', () => {
    const d = draftOf(versions[V_PUB]!, false);
    expect(d.label).toBe('');
    expect(writeOf(d)).toEqual({ problems: ['label'] });
    // A summary in one language only is refused (the backend wants every locale once one is given, DI-40).
    expect(writeOf({ ...d, label: '1.1', summary: { en: 'Clearer wording', fa: ' ' } })).toEqual({ problems: ['summary.fa'] });
    const ok = writeOf({ ...d, label: '۱.۱', summary: { en: 'Clearer wording', fa: 'متن روشن‌تر' } });
    expect('value' in ok && ok.value.policy_version).toBe('1.1');
    expect('value' in ok && ok.value.change_summary_translations).toEqual({ en: 'Clearer wording', fa: 'متن روشن‌تر' });
    expect(writeOf({ ...d, label: '1.1', body: { en: 'x', fa: '' } })).toEqual({ problems: ['body.fa'] });
  });

  it('patches only what changed', () => {
    const v = versions[V_DRAFT]!;
    const w = writeOf({ ...draftOf(v), title: { en: 'Agreement', fa: v.title_translations.fa! } });
    expect('value' in w && patchOf(v, w.value)).toEqual({ title_translations: { en: 'Agreement', fa: 'توافق‌نامه کاربری' } });
  });

  it('builds the publish body; keep or pause only for a consent text with re-consent', () => {
    const now = Date.parse('2026-11-20T08:00:00Z');
    const base = { when: 'at' as const, day: '2026-11-20', time: '10:00', reconsent: true, action: 'pause' as const };
    expect(publishOf(base, 'consent', 'Asia/Tehran', now)).toEqual({ problem: 'past' });
    expect(publishOf({ ...base, time: '13:00' }, 'consent', 'Asia/Tehran', now)).toEqual({
      value: { effective_at: '2026-11-20T09:30:00.000Z', requires_reconsent: true, reconsent_action: 'pause' },
    });
    expect(publishOf({ ...base, time: '11:00' }, 'blocking', 'Asia/Tehran', now)).toEqual({ problem: 'past' });
    expect(publishOf({ ...base, time: '13:00' }, 'blocking', 'Asia/Tehran', now)).toEqual({
      value: { effective_at: '2026-11-20T09:30:00.000Z', requires_reconsent: true },
    });
    expect(publishOf({ ...base, when: 'approval', reconsent: false }, 'consent', 'Asia/Tehran', now)).toEqual({
      value: { effective_at: '2026-11-20T08:00:00.000Z', requires_reconsent: false },
    });
  });
});

describe('Policies & consent texts page (AC14.T4)', () => {
  it('lists documents with the version in force and what is coming', async () => {
    const { transport: tr } = transport();
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Documents' });
    const terms = (await within(table).findByText('User Agreement')).closest('tr')!;
    expect(within(terms).getByText('Must accept again')).toBeInTheDocument();
    expect(within(terms).getByText('1 draft')).toBeInTheDocument();
    expect(within(table).getByText('Unknown (cookies)')).toBeInTheDocument();
    expect(within(table).getByText('None in force')).toBeInTheDocument();
  });

  it('shows a published version read-only in both languages', async () => {
    resetNav(`/policies?policy=terms&version=${V_PUB}`);
    const { transport: tr } = transport();
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const view = await screen.findByTestId('policy-version');
    expect(view).toHaveAttribute('data-status', 'published');
    expect(within(view).getByTestId('policy-readonly')).toBeInTheDocument();
    expect(within(view).queryByTestId('policy-form')).toBeNull();
    expect(within(view).getByLabelText('Text in Persian')).toHaveAttribute('dir', 'rtl');
    expect(within(view).getByLabelText('Text in English').textContent).toContain('Use CarPal fairly.');
  });

  it('creates a new version from the newest texts with a new label', async () => {
    resetNav('/policies?policy=terms&version=new');
    const { transport: tr, calls } = transport({
      'admin.policy_version_create': () => Response.json(full(summary(V_NEW, { status: 'draft', policy_version: '1.2' })), { status: 201 }),
    });
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const form = await screen.findByTestId('policy-form');
    expect(screen.getByText('Starts from the texts of version 1.1. Give it a new label.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Text (Persian)')).toHaveValue('# شرایط\n\nپیش‌نویس.');
    fireEvent.click(within(form).getByRole('button', { name: 'Create the draft' }));
    expect(within(form).getByText('Enter a label of up to 20 characters.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Version label'), { target: { value: '1.2' } });
    fireEvent.change(within(form).getByLabelText('What changed (English)'), { target: { value: 'New section on AI' } });
    fireEvent.change(within(form).getByLabelText('What changed (Persian)'), { target: { value: 'بخش تازه درباره هوش مصنوعی' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create the draft' }));
    const dialog = await screen.findByRole('dialog', { name: 'New draft of User Agreement' });
    reason(dialog, 'legal_update');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the draft' }));
    // The new draft opens at once.
    await vi.waitFor(() => expect(nav.replaced.at(-1)).toContain(`version=${V_NEW}`));
    const post = calls.find((c) => c.opId === 'admin.policy_version_create')!;
    expect(post.path).toBe('/v1/admin/policies/terms/versions');
    expect(post.body).toEqual({
      policy_version: '1.2',
      title_translations: { en: 'User Agreement', fa: 'توافق‌نامه کاربری' },
      body_translations: { en: '# Terms\n\nDraft.', fa: '# شرایط\n\nپیش‌نویس.' },
      change_summary_translations: { en: 'New section on AI', fa: 'بخش تازه درباره هوش مصنوعی' },
      reason: 'legal_update',
    });
  });

  it('saves a draft with If-Match and only the changed text', async () => {
    resetNav(`/policies?policy=terms&version=${V_DRAFT}`);
    const { transport: tr, calls } = transport({
      'admin.policy_version_update': () => Response.json(versions[V_DRAFT]),
    });
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const form = await screen.findByTestId('policy-form');
    const save = within(form).getByRole('button', { name: 'Save the draft' });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Text (Persian)'), { target: { value: '# شرایط\n\nمتن تازه.' } });
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: 'Save draft 1.1' });
    reason(dialog, 'translation');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    const patch = calls.find((c) => c.opId === 'admin.policy_version_update')!;
    expect(patch.method).toBe('PATCH');
    expect(patch.headers.get('if-match')).toBe('"v7"');
    expect(patch.body).toEqual({
      body_translations: { en: '# Terms\n\nDraft.', fa: '# شرایط\n\nمتن تازه.' },
      reason: 'translation',
    });
  });

  it('publishes a consent text with re-consent and keep preselected, for a second admin', async () => {
    resetNav(`/policies?policy=marketing&version=${V_CDRAFT}`);
    const { transport: tr, calls } = transport({
      'admin.policy_version_publish': () => Response.json(pending, { status: 202 }),
    });
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const panel = await screen.findByTestId('policy-publish');
    expect(within(panel).queryByTestId('reconsent-action')).toBeNull();
    fireEvent.click(within(panel).getByLabelText('People must agree to this version again'));
    const choice = within(panel).getByTestId('reconsent-action');
    expect(within(choice).getByLabelText('Stay in effect until confirmed')).toBeChecked();
    fireEvent.click(within(panel).getByLabelText('A date and time'));
    fireEvent.change(within(panel).getByLabelText('Day'), { target: { value: '2020-01-01' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send for approval' }));
    expect(within(panel).getByText('Choose a time that is not in the past.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText('As soon as a second admin approves'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Send for approval' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish Marketing messages 2.0' });
    expect(within(dialog).getByText('Re-consent; older consents: Stay in effect until confirmed')).toBeInTheDocument();
    reason(dialog, 'legal_update', 'Yearly review');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(panel).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.policy_version_publish')!;
    expect(post.path).toBe(`/v1/admin/policy-versions/${V_CDRAFT}/publish`);
    expect(post.body).toMatchObject({ requires_reconsent: true, reconsent_action: 'keep', reason: 'legal_update: Yearly review' });
    expect(Math.abs(Date.parse(post.body!.effective_at as string) - Date.now())).toBeLessThan(60_000);
  });

  it('never offers keep or pause for a legal policy', async () => {
    resetNav(`/policies?policy=terms&version=${V_DRAFT}`);
    const { transport: tr } = transport();
    renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'] });
    const panel = await screen.findByTestId('policy-publish');
    fireEvent.click(within(panel).getByLabelText('People must agree to this version again'));
    expect(within(panel).queryByTestId('reconsent-action')).toBeNull();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/policies?policy=marketing&version=${V_CDRAFT}`);
      const { transport: tr } = transport();
      renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'], locale });
      await screen.findByTestId('policy-publish');
      expect(await axeViolations()).toEqual([]);
    });
    it(`axe on a read-only version (${locale})`, async () => {
      resetNav(`/policies?policy=terms&version=${V_PUB}`);
      const { transport: tr } = transport();
      renderConsole(<PoliciesPage />, { transport: tr, roles: ['ADM'], locale });
      await screen.findByTestId('policy-readonly');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
