// P13.T10: the questions sitemap lists the hub, answered questions (paged within the budget) and the one-topic hub
// views whose first page holds enough answered questions — the same request the page makes, so both agree.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
vi.mock('../api', () => ({ ssrApi: () => ({ api: run }) }));
vi.mock('@/server/taxonomy', () => ({
  taxonomy: () => ({
    nodes: async (_locale: string, type: string) =>
      type === 'service_system'
        ? [
            { id: '00000000-0000-4000-8000-0000000000c1', parent_id: null },
            { id: '00000000-0000-4000-8000-0000000000c2', parent_id: null },
            { id: '00000000-0000-4000-8000-0000000000c3', parent_id: '00000000-0000-4000-8000-0000000000c2' },
          ]
        : [{ id: '00000000-0000-4000-8000-0000000000b1', parent_id: null }],
  }),
}));

const { questionEntries } = await import('./sitemap');
const { qaTopicIndexable, qaTopicOf, QA_TOPIC_MIN_ANSWERED } = await import('@/features/community/qa-filters');

const q = (id: string, status = 'answered') => ({ id, title: `Why does it squeak ${id}`, status, created_at: '2026-10-30T10:00:00Z' });

beforeEach(() => {
  run.mockReset();
});

describe('questions sitemap', () => {
  it('pages through answered questions, then adds the indexable topic views', async () => {
    run.mockImplementation(async (_op: string, { body }: { body: Record<string, unknown> }) => {
      if (body.status === 'answered') return body.cursor ? { items: [q('b')], next_cursor: null } : { items: [q('a')], next_cursor: 'c2' };
      if (body.category_node_id === '00000000-0000-4000-8000-0000000000c1')
        return { items: [q('1'), q('2'), q('3'), q('4', 'open')], next_cursor: null };
      return { items: [q('5'), q('6', 'open')], next_cursor: null };
    });
    const entries = await questionEntries();
    expect(entries.map((e) => e.paths.en)).toEqual([
      '/en/questions',
      '/en/questions/a-why-does-it-squeak-a',
      '/en/questions/b-why-does-it-squeak-b',
      '/en/questions?cat=00000000-0000-4000-8000-0000000000c1',
    ]);
    expect(entries[1]).toMatchObject({ lastModified: '2026-10-30T10:00:00Z', paths: { fa: '/fa/questions/a-why-does-it-squeak-a' } });
    // Top-level categories and brands only, each with the page's own request (no status, limit 20).
    const topicCalls = run.mock.calls.filter(([, a]) => !a.body.status);
    expect(topicCalls.map(([, a]) => a.body)).toEqual([
      { category_node_id: '00000000-0000-4000-8000-0000000000c1', limit: 20 },
      { category_node_id: '00000000-0000-4000-8000-0000000000c2', limit: 20 },
      { brand_node_id: '00000000-0000-4000-8000-0000000000b1', limit: 20 },
    ]);
  });

  it('keeps only the hub when Q&A is off, and stops at the budgets', async () => {
    run.mockRejectedValue(new Error('404 NOT_FOUND'));
    expect(await questionEntries()).toEqual([{ paths: { fa: '/fa/questions', en: '/en/questions' } }]);
    run.mockReset();
    run.mockResolvedValue({ items: [q('x')], next_cursor: 'more' });
    await questionEntries(2, 1);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('Q&A topic views', () => {
  it('are one category, or one brand with an optional model, without a status', () => {
    expect(qaTopicOf({ categoryId: 'c' })).toEqual({ kind: 'category', id: 'c' });
    expect(qaTopicOf({ brandId: 'b', modelId: 'm' })).toEqual({ kind: 'brand', id: 'b', modelId: 'm' });
    expect(qaTopicOf({ categoryId: 'c', brandId: 'b' })).toBeNull();
    expect(qaTopicOf({ categoryId: 'c', status: 'answered' })).toBeNull();
    expect(qaTopicOf({})).toBeNull();
    const answered = Array.from({ length: QA_TOPIC_MIN_ANSWERED }, () => ({ status: 'answered' }));
    expect(qaTopicIndexable(answered)).toBe(true);
    expect(qaTopicIndexable([...answered.slice(1), { status: 'open' }, { status: 'closed' }])).toBe(false);
  });
});
