// AC12 tests: the taxonomy rules (parents, attributes, labels in every locale, search folding, merge targets) and the
// screen: the tree and the missing-translations view, a node saved only with EN and FA labels and sent with If-Match,
// a new child, synonyms (a Latin-letter transliteration, an AI suggestion approved), a mapping, a merge filed for a
// second administrator and its job followed to the end, the zero-result numbers, the moderator's read-only view, and
// axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mapping, PendingChange, StaffTaxonomyNode, Synonym } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import {
  buildTree,
  checkDraft,
  childTypes,
  createBody,
  descendants,
  draftOf,
  enabledLocales,
  mergeTargets,
  nodeMatches,
  normalizeSearch,
  parseRegions,
  suggestSlug,
  updateBody,
  zeroResultRate,
} from './taxonomy-logic';
import { TaxonomyPage } from './taxonomy-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193b000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const BRAND = id(1);
const BRAND2 = id(2);
const MODEL = id(3);
const SYM = id(4);
const SYS = id(5);

function node(nid: string, o: Partial<StaffTaxonomyNode> = {}): StaffTaxonomyNode {
  return {
    id: nid,
    type: 'vehicle_brand',
    parent_id: null,
    name: { text: 'Name', locale: 'en' },
    description: null,
    slug: `node-${nid.slice(-2)}`,
    regions: ['IR'],
    attributes: null,
    sort_order: 1,
    status: 'active',
    merged_into_id: null,
    name_translations: { en: 'Name', fa: 'نام' },
    description_translations: null,
    missing_locales: [],
    version: 3,
    ...o,
  };
}

const brands = () => [
  node(BRAND, { slug: 'iran-khodro', name_translations: { en: 'Iran Khodro', fa: 'ایران خودرو' } }),
  node(BRAND2, { slug: 'iran-khodro-dup', name_translations: { en: 'IKCO' }, missing_locales: ['fa'] }),
];
const models = () => [
  node(MODEL, { type: 'vehicle_model', parent_id: BRAND, slug: 'samand', name_translations: { en: 'Samand', fa: 'سمند' } }),
];

function snapshot(map: Record<string, () => StaffTaxonomyNode[]>) {
  return (req: { search: string }) => {
    const type = new URLSearchParams(req.search).get('type') ?? '';
    return page(map[type]?.() ?? []);
  };
}

beforeEach(() => resetNav('/taxonomy'));
afterEach(() => vi.unstubAllGlobals());

describe('taxonomy rules (AC12)', () => {
  it('parents, child types and the cycle guard', () => {
    expect(childTypes('vehicle_brand')).toEqual(['vehicle_model', 'engine_type']);
    expect(childTypes('symptom')).toEqual(['symptom']);
    const a = node(id(10), { type: 'symptom' });
    const b = node(id(11), { type: 'symptom', parent_id: a.id });
    const c = node(id(12), { type: 'symptom', parent_id: b.id });
    const d = node(id(13), { type: 'symptom' });
    const index = buildTree([a, b, c, d], 'en');
    expect([...descendants(index, a.id)].sort()).toEqual([b.id, c.id].sort());
    expect(mergeTargets(index, a).map((n) => n.id)).toEqual([d.id]);
    expect(
      mergeTargets(index, c)
        .map((n) => n.id)
        .sort(),
    ).toEqual([a.id, b.id, d.id].sort());
    expect(mergeTargets(buildTree([a, { ...d, status: 'merged' }], 'en'), a)).toEqual([]);
  });

  it('labels are required in every enabled locale; slug, parent, regions and attributes are checked', () => {
    const locales = enabledLocales(null);
    expect(locales).toEqual(['en', 'fa']);
    expect(enabledLocales(node(BRAND, { name_translations: { en: 'x' }, missing_locales: ['fa'] }))).toEqual(['en', 'fa']);
    const d = { ...draftOf(node(MODEL, { type: 'vehicle_series', parent_id: null })), names: { en: 'Samand LX' }, slug: 'Bad Slug' };
    d.attributes = { production_start_year: '1800' };
    d.regions = 'IR, Iran';
    expect(checkDraft(d, locales).map((p) => p.field)).toEqual(['name', 'slug', 'parent', 'regions', 'attribute']);
    const ok = {
      ...d,
      names: { en: 'Samand LX', fa: 'سمند LX' },
      slug: 'samand-lx',
      parentId: MODEL,
      regions: 'ir ae',
      attributes: { production_start_year: '2001' },
    };
    expect(checkDraft(ok, locales)).toEqual([]);
    expect(createBody(ok, locales, 'new_item')).toMatchObject({
      type: 'vehicle_series',
      parent_id: MODEL,
      name_translations: { en: 'Samand LX', fa: 'سمند LX' },
      regions: ['IR', 'AE'],
      attributes: { production_start_year: 2001 },
      reason: 'new_item',
    });
    expect(updateBody(ok, locales, 'correction')).not.toHaveProperty('type');
    expect(parseRegions('IR،AE')).toEqual(['IR', 'AE']);
    expect(suggestSlug('Peugeot 206 Tip-2')).toBe('peugeot-206-tip-2');
  });

  it('search folds Arabic letter forms, Persian digits and marks', () => {
    expect(normalizeSearch('كيا ۲۰۶')).toBe('کیا 206');
    expect(nodeMatches(node(BRAND, { name_translations: { en: 'Kia', fa: 'کیا' } }), 'كيا')).toBe(true);
    expect(nodeMatches(node(BRAND, { slug: 'iran-khodro' }), 'KHODRO')).toBe(true);
    expect(zeroResultRate(0, 0)).toBeNull();
    expect(zeroResultRate(200, 30)).toBe(0.15);
  });
});

describe('taxonomy screen (AC12)', () => {
  it('shows the tree, the list with missing labels, and searches by any label', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }) });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    await waitFor(() => expect(screen.getAllByTestId('tax-node')).toHaveLength(2));
    expect(calls[0]!.search).toBe('?type=vehicle_brand&limit=500');
    fireEvent.click(screen.getByLabelText('Missing translations'));
    const table = await screen.findByRole('table', { name: 'Vehicle brands' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByRole('row', { name: /IKCO/ })).toHaveTextContent('Persian');
  });

  it('saves a node only with EN and FA labels, with a reason and If-Match from its version', async () => {
    resetNav(`/taxonomy?node=${BRAND2}`);
    const sent: { body: unknown; ifMatch: string | null }[] = [];
    const { transport } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }),
      'admin.taxonomy_node_update': (req, body) => {
        sent.push({ body, ifMatch: req.headers.get('if-match') });
        return Response.json(node(BRAND2, { version: 4 }));
      },
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('node-editor');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));
    expect(await within(editor).findByTestId('editor-problems')).toHaveTextContent('Enter the Persian label.');
    expect(sent).toEqual([]);
    fireEvent.change(within(editor).getByLabelText('Label (Persian)'), { target: { value: 'ایران خودرو ۲' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the node' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'translation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.ifMatch).toBe('"v3"');
    expect(sent[0]!.body).toMatchObject({
      name_translations: { en: 'IKCO', fa: 'ایران خودرو ۲' },
      slug: 'iran-khodro-dup',
      reason: 'translation',
    });
    expect(sent[0]!.body).not.toHaveProperty('type');
  });

  it('a change made meanwhile (412) offers a Reload', async () => {
    resetNav(`/taxonomy?node=${BRAND}`);
    const { transport } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }),
      'admin.taxonomy_node_update': () => problem(412, 'VERSION_MISMATCH'),
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('node-editor');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the node' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'correction' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('button', { name: /Reload/ })).toBeInTheDocument();
  });

  it('adds a model under a brand (the parent is set; the new node opens in its own type)', async () => {
    resetNav(`/taxonomy?node=${BRAND}`);
    let created: Record<string, unknown> | null = null;
    const { transport, calls } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({
        vehicle_brand: brands,
        vehicle_model: () => (created ? [...models(), node(id(9), { type: 'vehicle_model', parent_id: BRAND })] : models()),
      }),
      'admin.taxonomy_node_create': (_req, body) => {
        created = body;
        return Response.json(node(id(9), { type: 'vehicle_model', parent_id: BRAND }), { status: 201 });
      },
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Vehicle models here' }));
    const editor = await screen.findByTestId('node-editor');
    expect(editor).toHaveAttribute('data-mode', 'create');
    fireEvent.change(within(editor).getByLabelText('Label (English)'), { target: { value: 'Dena Plus' } });
    fireEvent.change(within(editor).getByLabelText('Label (Persian)'), { target: { value: 'دنا پلاس' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Suggest from the English label' }));
    expect(within(editor).getByLabelText('Slug')).toHaveValue('dena-plus');
    fireEvent.click(within(editor).getByRole('button', { name: 'Create node' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create the node' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'new_item' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create node' }));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ type: 'vehicle_model', parent_id: BRAND, slug: 'dena-plus', status: 'active' });
    expect(calls.find((c) => c.opId === 'admin.taxonomy_node_create')!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('synonyms: a Latin-letter transliteration needs its script; a pending AI suggestion is approved', async () => {
    resetNav(`/taxonomy?node=${BRAND}&tab=synonyms`);
    const syn = (o: Partial<Synonym>): Synonym =>
      ({
        id: id(70),
        term: 'irankhodro',
        locale: 'fa',
        synonym_type: 'transliteration',
        script: 'latin',
        taxonomy_node_id: BRAND,
        source: 'ai_suggested',
        status: 'pending_review',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...o,
      }) as Synonym;
    const posted: unknown[] = [];
    const { transport } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }),
      'admin.synonyms_list': () => page([syn({})]),
      'admin.synonym_create': (_r, body) => {
        posted.push(body);
        return Response.json(syn({ id: id(71), term: 'IKCO', source: 'manual', status: 'active' }), { status: 201 });
      },
      'admin.synonym_decide': (_r, body) => {
        posted.push(body);
        return Response.json(syn({ status: 'active' }));
      },
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    const panel = await screen.findByTestId('synonyms-panel');
    const row = await within(panel).findByRole('row', { name: /irankhodro/ });
    expect(within(row).getByText('Transliteration (Latin letters)')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    let dialog = await screen.findByRole('dialog', { name: 'Approve this suggestion' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'meets_policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posted).toEqual([{ decision: 'approve', reason: 'meets_policy' }]));

    const form = within(panel).getByTestId('synonym-add');
    fireEvent.change(within(form).getByLabelText('Term'), { target: { value: 'IKCO' } });
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'transliteration' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getByText('Choose the script of the transliteration.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Script/), { target: { value: 'latin' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    dialog = await screen.findByRole('dialog', { name: 'Add this term' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'search_gap' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ term: 'IKCO', locale: 'fa', synonym_type: 'transliteration', script: 'latin', reason: 'search_gap' });
  });

  it('mappings: a symptom mapped to a system with a weight', async () => {
    resetNav(`/taxonomy?type=symptom&node=${SYM}&tab=mappings`);
    const put: unknown[] = [];
    const { transport } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({
        symptom: () => [node(SYM, { type: 'symptom', slug: 'brake-noise', name_translations: { en: 'Brake noise', fa: 'صدای ترمز' } })],
        service_system: () => [node(SYS, { type: 'service_system', slug: 'brakes', name_translations: { en: 'Brakes', fa: 'ترمز' } })],
        service_task: () => [],
      }),
      'admin.mappings_list': () => page<Mapping>([]),
      'admin.mapping_upsert': (_r, body) => {
        put.push(body);
        return Response.json({ ...(body as object), id: id(80), source: 'manual' });
      },
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    const form = await screen.findByTestId('mapping-add');
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Brakes (brakes)' })).toBeInTheDocument());
    fireEvent.change(within(form).getByLabelText('Node (Service systems)'), { target: { value: SYS } });
    fireEvent.change(within(form).getByLabelText('Weight'), { target: { value: '80' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save mapping' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the mapping' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'correction' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({
      source_node_id: SYM,
      target_node_id: SYS,
      mapping_type: 'symptom_to_system',
      weight: 80,
      status: 'active',
      reason: 'correction',
    });
  });

  it('a merge waits for a second admin; once approved its job is followed until it ends', async () => {
    resetNav(`/taxonomy?node=${BRAND2}&tab=merge`);
    const change: PendingChange = {
      change_id: id(90),
      op_id: 'admin.taxonomy_merge',
      summary: 'Merge vehicle_brand "iran-khodro-dup" into "iran-khodro"',
      requested_by_display: 'Sara Staff',
      requested_at: new Date().toISOString(),
      reason: 'duplicate: same brand',
      status: 'pending',
      expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      decided_by_display: null,
      decided_at: null,
      decision_reason: null,
      job_id: null,
    };
    let approved = false;
    let jobReads = 0;
    const { transport } = scriptedTransport({
      'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }),
      'admin.taxonomy_merge': (_r, body) => {
        expect(body).toEqual({ into_node_id: BRAND, reason: 'duplicate: same brand' });
        return Response.json(change, { status: 202 });
      },
      'admin.four_eyes_list': () =>
        page(approved ? [{ ...change, status: 'approved', job_id: id(91), decided_by_display: 'Ali Admin' }] : [change]),
      'admin.job_get': () => {
        jobReads += 1;
        return Response.json({
          id: id(91),
          kind: 'taxonomy_merge',
          status: jobReads > 1 ? 'succeeded' : 'running',
          progress: jobReads > 1 ? 100 : 40,
          expires_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
    });
    const { queryClient } = renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'] });
    const panel = await screen.findByTestId('merge-panel');
    expect(within(panel).queryByRole('option', { name: /IKCO/ })).toBeNull();
    fireEvent.change(within(panel).getByLabelText(/^Merge into/), { target: { value: BRAND } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge this node' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'duplicate' } });
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'same brand' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(panel).findByText(/Waiting for a second staff member/)).toBeInTheDocument();

    approved = true;
    await queryClient.invalidateQueries({ queryKey: ['admin.four_eyes_list'] });
    const job = await within(panel).findByTestId('my-merges');
    await waitFor(() => expect(job.querySelector('[data-kit="job"]')).toHaveAttribute('data-status', 'succeeded'), { timeout: 8000 });
  }, 15000);

  it('zero-result searches from the search_and_map dashboard (counts, share, by day; no terms)', async () => {
    resetNav('/taxonomy?section=terms');
    const { transport, calls } = scriptedTransport({
      'admin.analytics_dashboard': () =>
        Response.json({
          key: 'search_and_map',
          from: '2026-10-21',
          to: '2026-11-20',
          metrics: [
            {
              metric_key: 'search.started',
              value: '200',
              unit: 'count',
              series: [
                { date: '2026-11-19', value: '120' },
                { date: '2026-11-20', value: '80' },
              ],
            },
            { metric_key: 'search.zero_result', value: '30', unit: 'count', series: [{ date: '2026-11-20', value: '30' }] },
          ],
        }),
    });
    renderConsole(<TaxonomyPage />, { transport, roles: ['MOD'] });
    const stats = await screen.findByTestId('terms-stats');
    expect(stats).toHaveAttribute('data-zero', '30');
    expect(within(stats).getByText('15 %')).toBeInTheDocument();
    expect(calls[0]!.path).toBe('/v1/admin/analytics/search_and_map');
    expect(calls[0]!.search).toMatch(/^\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText(/not the words people typed/)).toBeInTheDocument();
  });

  it('a moderator reads nodes, decides suggestions, and cannot create, edit, merge or map', async () => {
    resetNav(`/taxonomy?node=${BRAND}`);
    const { transport } = scriptedTransport({ 'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }) });
    renderConsole(<TaxonomyPage />, { transport, roles: ['MOD'] });
    const editor = await screen.findByTestId('node-editor');
    expect(within(editor).queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add to/ })).toBeNull();
    expect(screen.getByText('You can read this node; platform admins edit it.')).toBeInTheDocument();
  });

  it.each<Locale>(['en', 'fa'])('axe: no violations (%s)', async (locale) => {
    resetNav(`/taxonomy?node=${BRAND}`);
    const { transport } = scriptedTransport({ 'admin.taxonomy_snapshot': snapshot({ vehicle_brand: brands }) });
    renderConsole(<TaxonomyPage />, { transport, roles: ['ADM'], locale });
    await screen.findByTestId('node-editor');
    await waitFor(() => expect(screen.getAllByTestId('tax-node')).toHaveLength(2));
    expect(await axeViolations()).toEqual([]);
  });
});
