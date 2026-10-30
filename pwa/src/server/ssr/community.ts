// Server reads of the Q&A pages (P8): one question with its answers, related questions and the hub's first page,
// through the cached cp-ssr public reads. qna.enabled off answers 403 FEATURE_DISABLED (GD-13): the pages show the
// "not available right now" state with noindex instead of failing.
import 'server-only';
import type { PublicAnswer, PublicQuestion } from '@carpal/api-contracts';
import { ApiProblem } from '@/lib/api';
import type { Locale } from '@/lib/i18n/locales';
import { publicList, publicRead } from './public-reads';

export type QuestionRead =
  | { state: 'ok'; data: { question: PublicQuestion; answers: { items: PublicAnswer[]; next_cursor: string | null } } }
  | { state: 'missing' }
  | { state: 'off' };

const isOff = (err: unknown) => err instanceof ApiProblem && err.code === 'FEATURE_DISABLED';

export async function loadQuestion(locale: Locale, id: string): Promise<QuestionRead> {
  try {
    const r = await publicRead(locale, 'questions.get', { path: { question_id: id } });
    return r.ok ? { state: 'ok', data: r.data } : { state: 'missing' };
  } catch (err) {
    if (isOff(err)) return { state: 'off' };
    throw err;
  }
}

/** Words of a title worth searching for (the longest first); PublicQuestion carries labels, not node ids (DI-50). */
export function searchWords(title: string): string[] {
  const words = title
    .toLocaleLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((w) => [...w].length >= 4 && !/^\d+$/.test(w));
  return [...new Set(words)].sort((a, b) => [...b].length - [...a].length).slice(0, 2);
}

/** Up to `max` other questions sharing a significant title word. */
export async function relatedQuestions(locale: Locale, q: Pick<PublicQuestion, 'id' | 'title'>, max = 5): Promise<PublicQuestion[]> {
  const pages = await Promise.all(
    searchWords(q.title).map((text) => publicList(locale, 'questions.search', { body: { text, limit: max + 1 } })),
  );
  const out = new Map<string, PublicQuestion>();
  for (const page of pages) for (const item of page?.items ?? []) if (item.id !== q.id && !out.has(item.id)) out.set(item.id, item);
  return [...out.values()].slice(0, max);
}
