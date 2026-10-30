// P8.T7 (DOM): reaction toggling with the optimistic update and its rollback; the report modal (guests see the form and
// sign in to send, signed-in users send, 409 DUPLICATE → "You already reported this"); the question thread (the
// asker's Accept, the contact-data warning, a held answer shown as "Being reviewed — only you can see this", no
// Delete on the accepted answer); the ask page (a car or category is needed, the safety banner); Saved & Following
// (Unfollow with Undo); the home page's attention card and feed block.
import type { FeedItem, PublicAnswer, PublicOrgCard, PublicQuestion } from '@carpal/api-contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { guest, renderApp, signedIn } from '../../../tests/support/render-app';
import { ReportButton, ReportHost } from '@/components/shell/report';
import { ApiProblem } from '@/lib/api/problem';
import { AskForm } from './ask-form';
import { HomeScreen } from './home';
import { QuestionThread, type QuestionData } from './question-thread';
import { Reactions, useReaction } from './reactions';
import { SavedScreen } from './saved';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));

const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;
const Q = ID(1);
const FLAGS = { 'qna.enabled': true, 'community.comments.enabled': true, 'community.feed.enabled': true };

const org = (n: number): PublicOrgCard => ({
  id: ID(100 + n),
  slug: `shop-${n}`,
  name: `Reza Auto ${n}`,
  organization_type: 'independent_garage' as PublicOrgCard['organization_type'],
  roles: ['provider'],
  verified: true,
  overall_rating: '4.6',
  review_count: 12,
  top_badges: [],
  price_tier: null,
  measured_response_time_minutes: null,
  logo_url: null,
  portfolio_thumbnail_url: null,
});

const question = (o: Partial<PublicQuestion> = {}): PublicQuestion => ({
  id: Q,
  author: { display_name: 'Sara M.', avatar_url: null },
  vehicle: { brand: { text: 'BMW', locale: 'en' }, model: { text: '3 Series', locale: 'en' }, series: null },
  symptom: null,
  category: { text: 'Tyres', locale: 'en' },
  title: 'Which winter tyres fit an E90?',
  body: 'Mostly city driving in Tehran, some trips north.',
  content_locale: 'en',
  media: [],
  answer_count: 1,
  accepted_answer_id: null,
  status: 'open',
  created_at: '2026-10-20T10:00:00Z',
  ...o,
});

const answer = (n: number, o: Partial<PublicAnswer> = {}): PublicAnswer => ({
  id: ID(10 + n),
  question_id: Q,
  author: { display_name: `Mehdi ${n}`, avatar_url: null },
  organization: null,
  body: '225/45 R17 front is the safe choice.',
  content_locale: 'en',
  helpful_count: 2,
  accepted: false,
  created_at: '2026-10-21T10:00:00Z',
  ...o,
});

const data = (q: PublicQuestion, answers: PublicAnswer[]): QuestionData => ({
  question: q,
  answers: { items: answers, next_cursor: null },
});

beforeEach(() => {
  navigation.reset('/en/questions/x');
  localStorage.clear();
});

/** A bare button over useReaction, so the test sees each state. */
function Probe({ send, onError }: { send: (on: boolean) => Promise<number>; onError?: () => void }) {
  const r = useReaction({ type: 'answer', id: ID(11) }, 'helpful', 2, { send, onError });
  return (
    <button type="button" data-on={String(r.on)} data-busy={String(r.busy)} onClick={() => void r.toggle()}>
      {r.count}
    </button>
  );
}

describe('reactions (optimistic update and rollback)', () => {
  it('shows the guess at once, then the server count', async () => {
    let resolve!: (n: number) => void;
    const send = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    renderApp(<Probe send={send} />, { locale: 'en', session: signedIn() });
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(button).toHaveAttribute('data-on', 'true');
    expect(button).toHaveAttribute('data-busy', 'true');
    expect(button).toHaveTextContent('3');
    await act(async () => resolve(7));
    expect(button).toHaveTextContent('7');
    expect(button).toHaveAttribute('data-busy', 'false');
    expect(send).toHaveBeenCalledWith(true);
  });

  it('puts the earlier state back when the server refuses', async () => {
    const onError = vi.fn();
    const send = vi.fn(async () => {
      throw new ApiProblem(422, { code: 'VALIDATION_FAILED' });
    });
    renderApp(<Probe send={send} onError={onError} />, { locale: 'en', session: signedIn() });
    const button = screen.getByRole('button');
    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(button).toHaveAttribute('data-on', 'false');
    expect(button).toHaveTextContent('2');
  });

  it('sends reactions.put and remembers the reaction in this browser', async () => {
    const {
      api: { calls },
    } = renderApp(<Reactions target={{ type: 'answer', id: ID(11) }} counts={{ helpful: 2 }} />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'reactions.put': () => ({ count: 3 }) },
    });
    const button = screen.getByRole('button', { name: /Helpful/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
    expect(button).toHaveTextContent('3');
    expect(calls.find((c) => c.opId === 'reactions.put')?.args).toMatchObject({
      body: { target: { type: 'answer', id: ID(11) }, reaction_type: 'helpful' },
    });
    expect(localStorage.getItem('cp:community:reactions:u1')).toContain(`helpful:answer:${ID(11)}`);
  });
});

describe('report modal (W-RPT-01)', () => {
  it('lets guests pick a reason and asks them to sign in to send', async () => {
    navigation.reset('/en/questions/x');
    const {
      api: { calls },
    } = renderApp(
      <>
        <ReportButton targetType="answer" targetId={ID(11)} />
        <ReportHost />
      </>,
      { locale: 'en', session: guest },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report content' });
    fireEvent.click(within(dialog).getByLabelText('Unsafe advice'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to send your report' })).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'reports.create')).toBe(false);
  });

  it('sends the report, and says so when it was already reported', async () => {
    let first = true;
    const {
      api: { calls },
    } = renderApp(
      <>
        <ReportButton targetType="comment" targetId={ID(12)} />
        <ReportHost />
      </>,
      {
        locale: 'en',
        session: signedIn(),
        handlers: {
          'reports.create': () => {
            if (first) {
              first = false;
              return { report_id: ID(99), status: 'open' };
            }
            throw new ApiProblem(409, { code: 'DUPLICATE' });
          },
        },
      },
    );
    const send = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Report' }));
      const dialog = await screen.findByRole('dialog', { name: 'Report content' });
      fireEvent.click(within(dialog).getByLabelText('Spam or advertising'));
      fireEvent.change(within(dialog).getByLabelText('Details (optional)'), { target: { value: 'Same link everywhere' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    };
    await send();
    expect(await screen.findByText('Thanks — our team will review it.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'reports.create')?.args).toEqual({
      body: { target_type: 'comment', target_id: ID(12), reason: 'spam', details: 'Same link everywhere' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Report content' })).not.toBeInTheDocument());
    await send();
    expect(await screen.findByText('You already reported this. Our team is on it.')).toBeInTheDocument();
  });
});

describe('question thread (W-PUB-06)', () => {
  it('lets the asker accept an answer and hides Delete on the accepted one', async () => {
    const initial = data(question(), [answer(1)]);
    const accepted = question({ status: 'answered', accepted_answer_id: ID(11) });
    const {
      api: { calls },
    } = renderApp(<QuestionThread initial={initial} />, {
      locale: 'en',
      session: signedIn('Sara M.'),
      flags: FLAGS,
      handlers: {
        'questions.get': () => initial,
        'answers.accept': () => accepted,
        'comments.list': () => ({ items: [], next_cursor: null }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept answer' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'answers.accept')).toBe(true));
    expect(await screen.findByText('Answer accepted. Thanks for closing the loop.')).toBeInTheDocument();
    const item = document.querySelector(`[data-answer="${ID(11)}"]`) as HTMLElement;
    expect(within(item).getByText('Accepted answer')).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Accept answer' })).toBeNull();
  });

  it('warns before sending contact data and shows the held answer as being reviewed', async () => {
    const initial = data(question({ author: { display_name: 'Someone else', avatar_url: null } }), []);
    const held = answer(2, {
      author: { display_name: 'Sara M.', avatar_url: null },
      body: 'Call me on 0912 345 6789 for the tyres',
      helpful_count: 0,
    });
    let answers: PublicAnswer[] = [];
    renderApp(<QuestionThread initial={initial} />, {
      locale: 'en',
      session: signedIn('Sara M.'),
      flags: FLAGS,
      handlers: {
        'questions.get': () => data(initial.question, answers),
        'answers.create': () => {
          answers = [held];
          return held;
        },
        'comments.list': () => ({ items: [], next_cursor: null }),
      },
    });
    expect(screen.queryByRole('button', { name: 'Accept answer' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Share what worked for you'), { target: { value: held.body } });
    expect(screen.getByText('Posts with links, emails or phone numbers are checked by our team first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post answer' }));
    expect(await screen.findByText('Being reviewed — only you can see this')).toBeInTheDocument();
    const item = document.querySelector(`[data-answer="${held.id}"]`) as HTMLElement;
    expect(within(item).queryByRole('button', { name: /Helpful/ })).toBeNull();
    expect(within(item).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('asks guests to sign in to answer, keeping the text in the intent', async () => {
    renderApp(<QuestionThread initial={data(question(), [])} />, { locale: 'en', session: guest, flags: FLAGS });
    fireEvent.change(screen.getByLabelText('Share what worked for you'), { target: { value: 'Premium winter tyres with run-flat.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post answer' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to post your answer' })).toBeInTheDocument();
    expect(screen.getByText('No answers yet. Be the first to help.')).toBeInTheDocument();
  });
});

describe('ask page (W-QA-02)', () => {
  it('needs a car or a category, and shows the safety banner with Help Me', async () => {
    const {
      api: { calls },
    } = renderApp(<AskForm />, {
      locale: 'en',
      session: guest,
      flags: FLAGS,
      handlers: {
        'safety.check': () => ({ flag: true, level: 'urgent', message_i18n_key: null, urgent_help_available: true }),
        'questions.search': () => ({ items: [], next_cursor: null }),
        'taxonomy.suggest': () => ({ items: [] }),
        'taxonomy.snapshot': () => ({ items: [], next_cursor: null }),
      },
    });
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'My brake pedal feels soft' } });
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'It sinks to the floor when I stop.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post question' }));
    expect(screen.getByText('Choose your car or a category so the right people see it.')).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'questions.create')).toBe(false);
    expect(await screen.findByText('This sounds like a safety issue', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Help Me' })).toBeInTheDocument();
  });

  it('shows the flag-off state', () => {
    renderApp(<AskForm />, { locale: 'en', session: guest, flags: {} });
    expect(screen.getByText('Questions and answers are not available right now')).toBeInTheDocument();
  });
});

describe('Saved & Following (W-NET-01)', () => {
  it('unfollows with Undo restoring the bell', async () => {
    navigation.reset('/en/saved?tab=following');
    const follow = { organization: org(1), notification_preference: 'important_only' as const, followed_at: '2026-10-01T00:00:00Z' };
    const {
      api: { calls },
    } = renderApp(<SavedScreen />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'follows.list': () => ({ items: [follow], next_cursor: null }),
        'follows.delete': () => ({ ok: true }),
        'follows.put': () => follow,
      },
    });
    expect(await screen.findByText('Reza Auto 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Notifications from Reza Auto 1')).toHaveValue('important_only');
    fireEvent.click(screen.getByRole('button', { name: 'Unfollow' }));
    expect(await screen.findByText('You unfollowed Reza Auto 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(calls.find((c) => c.opId === 'follows.put')?.args).toMatchObject({
        path: { org_id: org(1).id },
        body: { notification_preference: 'important_only' },
      }),
    );
  });
});

describe('home (W-FEED-01)', () => {
  it('asks to add a first car and renders the Discover stream with its blocks', async () => {
    const feed: FeedItem[] = [
      { kind: 'nearby_provider', ref: { type: 'organization', id: org(1).id }, card: { organization: org(1), distance_km: '1.2' } },
      {
        kind: 'qna',
        ref: { type: 'question', id: Q },
        card: { title: 'Winter tyres for E90?', status: 'open', answer_count: 2, created_at: '2026-10-20T00:00:00Z' },
      },
    ];
    const {
      api: { calls },
    } = renderApp(<HomeScreen cityKey="tehran" />, {
      locale: 'en',
      session: signedIn(),
      flags: FLAGS,
      handlers: {
        'vehicles.list': () => ({ items: [], next_cursor: null }),
        'vehicles.transfers_list': () => ({ items: [], next_cursor: null }),
        'follows.list': () => ({ items: [], next_cursor: null }),
        'feed.discover': () => ({ items: feed, next_cursor: null }),
      },
    });
    expect(await screen.findByText('Add your car for better matches and reminders.')).toBeInTheDocument();
    expect(await screen.findByText('Reza Auto 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Winter tyres for E90?' })).toHaveAttribute('href', expect.stringContaining('/en/questions/'));
    expect(calls.find((c) => c.opId === 'feed.discover')?.args).toMatchObject({
      body: { location: { mode: 'chosen_city', city_key: 'tehran' }, limit: 20 },
    });
    expect(screen.getByText('Make your feed more useful')).toBeInTheDocument();
  });
});
