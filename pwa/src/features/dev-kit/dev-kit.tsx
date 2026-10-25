'use client';
// Test and demo page of the P3 global patterns (CARPAL_PWA_DEMO=1 only; never in prod): the gated demo Follow action
// that must survive sign-in (P3 acceptance), toast with Undo, a modal with a URL, a hover card, an infinite list with
// Back to top, skeletons, the GD-13 states, the vehicle picker and the formatters. Labels of the demo controls are
// English on purpose (not product copy); everything the patterns themselves show comes from the dictionary.
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { SafetyBanner } from '@/components/ds/banner';
import { Urgency } from '@/components/ds/urgency';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { HoverCard } from '@/components/shell/hover-card';
import { InfiniteList } from '@/components/shell/infinite-list';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, type StateKind } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { UrlModal, useUrlModal } from '@/components/shell/url-modal';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

export const DEMO_SHOP = { id: 'demo-shop', name: 'Reza Auto Suspension' };
const FOLLOW_KEY = 'cp:demo-follow';
const STATES: StateKind[] = ['notAvailable', 'featureOff', 'aiOff', 'beingReviewed', 'removed', 'noAccess'];

const followListeners = new Set<() => void>();
function readFollow(): boolean {
  try {
    return sessionStorage.getItem(FOLLOW_KEY) === '1';
  } catch {
    return false;
  }
}
function writeFollow(v: boolean) {
  try {
    if (v) sessionStorage.setItem(FOLLOW_KEY, '1');
    else sessionStorage.removeItem(FOLLOW_KEY);
  } catch {
    /* ignore */
  }
  for (const fn of followListeners) fn();
}
function subscribeFollow(fn: () => void) {
  followListeners.add(fn);
  return () => followListeners.delete(fn);
}

function FollowDemo() {
  const t = useT();
  const toast = useToast();
  const gate = useGatedAction();
  const following = useSyncExternalStore(subscribeFollow, readFollow, () => false);

  const follow = useCallback(() => {
    writeFollow(true);
    toast(t('shell.intent.followed', { name: DEMO_SHOP.name }), { undo: () => writeFollow(false) });
  }, [t, toast]);

  // After sign-in the saved intent comes back here once; the handler repeats the follow and returns the toast.
  useIntentHandler('demo.follow', (intent) => {
    if (intent.target !== DEMO_SHOP.id) return;
    writeFollow(true);
    return t('shell.intent.followed', { name: DEMO_SHOP.name });
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <HoverCard
        label={DEMO_SHOP.name}
        card={
          <span className="flex flex-col gap-2">
            <Bidi>{DEMO_SHOP.name}</Bidi>
            <Badge tone="accent" icon="shield">
              Verified Business
            </Badge>
          </span>
        }
      >
        <a href="#follow" className="pwa-link">
          <Bidi>{DEMO_SHOP.name}</Bidi>
        </a>
      </HoverCard>
      <Button
        id="follow"
        icon={following ? 'check' : 'plus'}
        aria-pressed={following}
        onClick={() =>
          following
            ? writeFollow(false)
            : gate({ type: 'demo.follow', target: DEMO_SHOP.id, title: t('shell.intent.follow', { name: DEMO_SHOP.name }), run: follow })
        }
      >
        {following ? 'Following' : 'Follow'}
      </Button>
    </div>
  );
}

function ListDemo() {
  const t = useT();
  const f = useFormat();
  const [pages, setPages] = useState(1);
  const items = Array.from({ length: pages * 20 }, (_, i) => i + 1);
  return (
    <InfiniteList
      items={items}
      getKey={(i) => String(i)}
      renderItem={(i) => <span className="pwa-text-body">{f.number(i)}</span>}
      status="success"
      hasNextPage={pages < 6}
      isFetchingNextPage={false}
      fetchNextPage={() => setPages((p) => p + 1)}
      refetch={() => setPages(1)}
      empty={<StateView kind="empty" t={t} />}
      label="Demo list"
      restoreKey="dev-kit"
    />
  );
}

export function DevKit() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const modal = useUrlModal('demo');
  const [pick, setPick] = useState<VehiclePick>(EMPTY_PICK);
  const [now] = useState(() => Date.now());

  return (
    <div className="flex flex-col gap-8 py-6" lang="en" dir="ltr">
      <h1 className="title-1 m-0">Dev kit</h1>

      <section className="flex flex-col gap-3" aria-labelledby="dk-follow">
        <h2 id="dk-follow" className="title-2 m-0">
          Gated action
        </h2>
        <FollowDemo />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dk-patterns">
        <h2 id="dk-patterns" className="title-2 m-0">
          Toast and modal
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => toast(t('consent.saved'), { undo: () => toast(t('common.actions.undo')) })}>Show toast</Button>
          <Button onClick={() => modal.open()}>Open modal</Button>
        </div>
        <UrlModal control={modal} name="demo" title={t('shell.intent.title')}>
          <p className="pwa-text-body">{t('shell.intent.text')}</p>
        </UrlModal>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dk-format">
        <h2 id="dk-format" className="title-2 m-0">
          Formatting
        </h2>
        <dl className="pwa-dl" dir="auto">
          <dt>Number</dt>
          <dd dir="auto" data-testid="fmt-number">
            {f.number(1234567)}
          </dd>
          <dt>Date</dt>
          <dd dir="auto" data-testid="fmt-date">
            {f.date('2026-10-25T08:30:00Z', 'dateLong')}
          </dd>
          <dt>Time</dt>
          <dd dir="auto" data-testid="fmt-time">
            {f.date('2026-10-25T14:05:00Z', 'time')}
          </dd>
          <dt>Relative</dt>
          <dd dir="auto" data-testid="fmt-relative">
            {f.relative(now - 3 * 86_400_000, now)}
          </dd>
          <dt>Money</dt>
          <dd dir="auto" data-testid="fmt-money">
            {f.money('18500000', 'IRR')}
          </dd>
          <dt>Distance</dt>
          <dd dir="auto" data-testid="fmt-distance">
            {f.distance(2450)}
          </dd>
          <dt>Plate</dt>
          <dd>
            <Bidi ltr>12 ب 345 - 67</Bidi>
          </dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dk-vehicle">
        <h2 id="dk-vehicle" className="title-2 m-0">
          Vehicle picker
        </h2>
        <VehiclePicker value={pick} onChange={setPick} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dk-states">
        <h2 id="dk-states" className="title-2 m-0">
          States
        </h2>
        <SafetyBanner title={t('states.aiOff.title')} text={t('states.aiOff.text')} />
        <div className="flex flex-wrap gap-2">
          <Urgency level="critical" label="Safety-critical" />
          <Urgency level="urgent" label="Urgent" />
          <Urgency level="soon" label="Soon" />
          <Urgency level="ok" label="Not urgent" />
        </div>
        {STATES.map((k) => (
          <StateView key={k} kind={k} t={t} compact headingLevel={3} />
        ))}
        <SkeletonCard />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dk-list">
        <h2 id="dk-list" className="title-2 m-0">
          Infinite list
        </h2>
        <ListDemo />
      </section>
    </div>
  );
}
