// AC14-2 DOM tests of the moderation additions (backend S18-S22): views and the source / reason filters sent to
// admin.cases_list (comma-separated arrays), the author with their history and the content around a comment
// (admin.case_context), and the actions with parameters: reduce weight, edit request (span found in the text),
// lower fitment confidence, merge into another organization, image redaction by typed boxes; the rules of
// case-logic; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationCase } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { cleanBox, editSpanOf, fitmentChoices, moreActions, parseTarget, percentOf, viewQuery } from './case-logic';
import { CaseWorkspace } from './case-workspace';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const C1 = id(1);
const T1 = id(11);
const ORG = id(21);
const OTHER = id(22);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const PURPOSE = `case:${C1}`;

const kase = (target: ModerationCase['target'], o: Partial<ModerationCase> = {}): ModerationCase =>
  ({
    id: C1,
    created_at: ago(2),
    updated_at: ago(2),
    version: 1,
    case_type: target.type,
    target,
    source: 'user_report',
    reason: 'fake',
    severity: 'medium',
    ai_risk_score: null,
    ai_flag_insight_id: null,
    status: 'open',
    assigned_to_display: 'Sara Staff',
    resolution: null,
    resolved_at: null,
    report_count: 1,
    target_summary: null,
    ...o,
  }) as ModerationCase;

const author = {
  user_id: id(5),
  display_name: 'Ali R.',
  role: 'member',
  organization: null,
  history: { published: 12, removed: 2, warnings: 1 },
};

const snapshots: Record<string, Record<string, unknown>> = {
  review: {
    type: 'review',
    id: T1,
    available: true,
    subject_organization_id: ORG,
    subject_type: 'provider',
    overall_rating: 1,
    title: 'Terrible',
    body: 'They broke my mirror and charged me twice.',
    status: 'published',
    confirmation_path: 'visit_based',
    verified_status: 'appointment_verified',
    created_at: ago(40),
    author,
  },
  comment: {
    type: 'comment',
    id: T1,
    available: true,
    target: { type: 'post', id: id(12) },
    body: 'Buy cheap parts here',
    status: 'active',
    moderation_status: 'approved',
    created_at: ago(5),
    author,
  },
  inventory_fitment: {
    type: 'inventory_fitment',
    id: T1,
    available: true,
    inventory_item_id: id(13),
    listing: { sku: 'BRK-1', name_translations: { en: 'Brake pad' }, status: 'active' },
    brand_node_id: id(14),
    model_node_id: null,
    series_node_id: null,
    year_start: 2010,
    year_end: 2015,
    confidence: 'confirmed',
    source: 'manual',
    status: 'active',
  },
  organization: {
    type: 'organization',
    id: ORG,
    available: true,
    name: 'Asa Auto',
    organization_type: 'provider',
    slug: null,
    status: 'active',
    verification_status: 'verified',
    trust_score: 50,
    created_at: ago(500),
  },
  media_asset: {
    type: 'media_asset',
    id: T1,
    available: true,
    purpose: 'review_photo',
    media_type: 'image',
    privacy_level: 'public',
    status: 'active',
    scan_status: 'clean',
    moderation_status: 'approved',
    owner_type: 'user',
    owner_id: id(5),
    created_at: ago(5),
    redaction_status: 'not_needed',
    author,
  },
};

function setup(type: keyof typeof snapshots, queue: 'reviews' | 'content' | 'inventory' | 'accounts') {
  const snap = snapshots[type]!;
  const target = { type: type as ModerationCase['target']['type'], id: snap.id as string };
  resetNav(`/x?case=${C1}&purpose=${encodeURIComponent(PURPOSE)}`);
  const s = scriptedTransport({
    'admin.cases_list': () => page([kase(target)]),
    'admin.case_get': () => Response.json({ case: kase(target), actions: [], target_snapshot: snap }),
    'admin.case_context': () =>
      Response.json({
        parent: {
          type: 'post',
          id: id(12),
          available: true,
          title: 'Winter tyres',
          body: 'Our offer for the winter',
          status: 'published',
          created_at: ago(9),
        },
        items: [{ ...snapshots.comment, id: id(15), body: 'Nice offer', author: { ...author, display_name: 'Mina' } }, snapshots.comment],
        total: 2,
      }),
    'admin.case_action': (_req, body) =>
      Response.json(
        { id: 'a1', moderation_case_id: C1, action_type: body!.action_type, target, reason: 'x', actor_display: 'Mo', created_at: ago(0) },
        { status: 201 },
      ),
    'admin.staff_list': () => page([]),
    'admin.media_download_url': () => Response.json({ url: 'https://storage.test/img.png', expires_at: ago(-0.1) }),
  });
  renderConsole(<CaseWorkspace queue={queue} tableId="t" listLabel="Cases" emptyText="None" views={queue === 'content'} />, {
    transport: s.transport,
    roles: ['MOD'],
  });
  return s;
}

const giveReason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => resetNav('/x'));

describe('Case list filters (AC14-2)', () => {
  it('a view and the reason filter go to the server as comma-separated arrays', async () => {
    resetNav('/x?type=post&view=consent');
    const { transport, calls } = scriptedTransport({ 'admin.cases_list': () => page([]) });
    renderConsole(<CaseWorkspace queue="content" tableId="t" listLabel="Cases" emptyText="None" views />, { transport, roles: ['MOD'] });
    await screen.findByRole('table', { name: 'Cases' });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const q = new URLSearchParams(calls[0]!.search);
    expect(q.get('reason')).toBe('consent_issue,redaction_issue,non_consensual_media,privacy');
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'ai_flag' } });
    await waitFor(() => expect(new URLSearchParams(calls.at(-1)!.search).get('source')).toBe('ai_flag'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'spam' } });
    await waitFor(() => expect(new URLSearchParams(calls.at(-1)!.search).get('reason')).toBe('spam'));
  });
});

describe('Case additions (AC14-2)', () => {
  it('a comment shows its author with history and the content around it', async () => {
    const { calls } = setup('comment', 'content');
    expect(await screen.findByTestId('author-history')).toHaveTextContent('12 published, 2 removed, 1 warnings');
    const context = await screen.findByTestId('case-context');
    expect(within(context).getByTestId('context-parent')).toHaveTextContent('Our offer for the winter');
    const items = await within(context).findAllByTestId('context-item');
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAttribute('data-current', 'true');
    expect(calls.find((c) => c.opId === 'admin.case_context')!.headers.get('carpal-access-purpose')).toBe(PURPOSE);
  });

  it('a published review: reduce weight sends weight_factor', async () => {
    const { calls } = setup('review', 'reviews');
    const panel = await screen.findByTestId('more-reduce_weight');
    fireEvent.change(within(panel).getByLabelText('Weight to keep'), { target: { value: '0.25' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reduce the weight' }));
    const dialog = await screen.findByRole('dialog', { name: "Reduce the review's weight" });
    expect(dialog).toHaveTextContent('security key');
    giveReason(dialog, 'suspicious_pattern', 'Same device as the owner');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reduce the weight' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.case_action')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.case_action')!.body).toEqual({
      action_type: 'reduce_weight',
      reason: 'suspicious_pattern: Same device as the owner',
      params: { weight_factor: '0.25' },
    });
  });

  it('a published review: the edit request finds the passage and sends its span and the message', async () => {
    const { calls } = setup('review', 'reviews');
    const panel = await screen.findByTestId('more-edit_request');
    fireEvent.change(within(panel).getByLabelText('The passage to change'), { target: { value: 'charged me three times' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ask for the edit' }));
    expect(within(panel).getByText(/These words are not in that part/)).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('The passage to change'), { target: { value: 'charged me twice' } });
    fireEvent.change(within(panel).getByLabelText('Message to the author'), { target: { value: 'Please keep to what you can show.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ask for the edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask the author to edit' });
    giveReason(dialog, 'wrong_information', 'Unproven claim');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for the edit' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.case_action')).toBe(true));
    const body = 'They broke my mirror and charged me twice.';
    const start = body.indexOf('charged me twice');
    expect(calls.find((c) => c.opId === 'admin.case_action')!.body).toMatchObject({
      action_type: 'edit_request',
      params: {
        edit_spans: [{ field: 'body', start, end: start + 'charged me twice'.length }],
        edit_message: 'Please keep to what you can show.',
      },
    });
  });

  it('a confirmed fitment row is lowered to a chosen confidence', async () => {
    const { calls } = setup('inventory_fitment', 'inventory');
    const panel = await screen.findByTestId('more-downgrade_fitment');
    fireEvent.click(within(panel).getByLabelText('Not sure it fits'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Lower the confidence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Lower the fitment confidence' });
    giveReason(dialog, 'inaccurate_fitment');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lower the confidence' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.case_action')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.case_action')!.body).toMatchObject({ params: { fitment_confidence: 'uncertain' } });
  });

  it('an organization case merges into another organization by id', async () => {
    const { calls } = setup('organization', 'accounts');
    const panel = await screen.findByTestId('more-merge_duplicate');
    fireEvent.change(within(panel).getByLabelText('ID of the organization that stays'), { target: { value: ORG } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Merge' }));
    expect(within(panel).getByText('Enter the ID of another organization.')).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('ID of the organization that stays'), { target: { value: OTHER } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge into another organization' });
    giveReason(dialog, 'duplicate', 'Same shop');
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.case_action')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.case_action')!.body).toMatchObject({
      action_type: 'merge_duplicate',
      params: { merge_into_id: OTHER },
    });
  });

  it('an image: boxes typed in percent are sent as fractions; a box can be removed', async () => {
    const { calls } = setup('media_asset', 'content');
    const panel = await screen.findByTestId('more-apply_redaction');
    fireEvent.click(within(panel).getByRole('button', { name: 'Black out' }));
    expect(within(panel).getByText('Draw or add at least one box.')).toBeInTheDocument();
    const fill = (x: string, y: string, w: string, h: string) => {
      fireEvent.change(within(panel).getByLabelText('From the left'), { target: { value: x } });
      fireEvent.change(within(panel).getByLabelText('From the top'), { target: { value: y } });
      fireEvent.change(within(panel).getByLabelText('Width'), { target: { value: w } });
      fireEvent.change(within(panel).getByLabelText('Height'), { target: { value: h } });
      fireEvent.click(within(panel).getByRole('button', { name: 'Add the box' }));
    };
    fill('10', '20', '30', '15');
    fill('50', '50', '10', '10');
    expect(within(panel).getAllByTestId('redaction-box')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove box 2' }));
    expect(within(panel).getAllByTestId('redaction-box')).toHaveLength(1);
    fireEvent.click(within(panel).getByRole('button', { name: 'Black out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Black out parts of the image' });
    giveReason(dialog, 'plate_visible');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Black out' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.case_action')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.case_action')!.body).toMatchObject({
      action_type: 'apply_redaction',
      params: { redaction_regions: [{ x: '0.1000', y: '0.2000', w: '0.3000', h: '0.1500' }] },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show the image to mark it' }));
    expect(await within(panel).findByTestId('redaction-frame')).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations on a review case with the new actions (${locale})`, async () => {
      const snap = snapshots.review!;
      resetNav(`/x?case=${C1}&purpose=${encodeURIComponent(PURPOSE)}`);
      const { transport } = scriptedTransport({
        'admin.cases_list': () => page([kase({ type: 'review', id: T1 })]),
        'admin.case_get': () => Response.json({ case: kase({ type: 'review', id: T1 }), actions: [], target_snapshot: snap }),
        'admin.staff_list': () => page([]),
      });
      renderConsole(<CaseWorkspace queue="reviews" tableId="t" listLabel="Cases" emptyText="None" />, {
        transport,
        roles: ['MOD'],
        locale,
      });
      await screen.findByTestId('more-edit_request');
      await screen.findByTestId('case-author');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

describe('moderation rules (AC14-2)', () => {
  const tg = (type: string, data: Record<string, unknown>) => parseTarget({ type, id: T1, available: true, ...data });
  it('moreActions per target and state', () => {
    expect(moreActions(tg('review', { status: 'published' }))).toEqual(['reduce_weight', 'edit_request']);
    expect(moreActions(tg('review', { status: 'removed' }))).toEqual([]);
    expect(moreActions(tg('inventory_fitment', { confidence: 'uncertain' }))).toEqual([]);
    expect(moreActions(tg('organization', { status: 'merged' }))).toEqual([]);
    expect(moreActions(tg('media_asset', { media_type: 'image', status: 'active', redaction_status: 'pending' }))).toEqual([]);
    expect(moreActions(tg('media_asset', { media_type: 'video', status: 'active' }))).toEqual([]);
  });
  it('fitment choices, edit spans, boxes and percents', () => {
    expect(fitmentChoices('confirmed')).toEqual(['likely', 'uncertain']);
    expect(fitmentChoices('likely')).toEqual(['uncertain']);
    expect(editSpanOf('abc def', 'def')).toEqual({ start: 4, end: 7 });
    expect(editSpanOf('abc', 'x')).toBeNull();
    expect(cleanBox({ x: 0.5, y: 0.5, w: -0.2, h: -0.2 })).toEqual({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 });
    expect(cleanBox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.9, y: 0.9, w: expect.closeTo(0.1), h: expect.closeTo(0.1) });
    expect(cleanBox({ x: 0.1, y: 0.1, w: 0.001, h: 0.5 })).toBeNull();
    expect(percentOf('12,5')).toBe(0.125);
    expect(percentOf('101')).toBeNull();
    expect(viewQuery('reported')).toEqual({ source: ['user_report'] });
    expect(viewQuery('')).toEqual({});
  });
});
