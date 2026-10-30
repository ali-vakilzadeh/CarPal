// P9.T1/T6: the notification dictionary against the backend's templates and routes (drift check, BA-18), the deep-link
// table of Docs/21 §6, the tab filters and the unread-count polling (Poll-After, backoff, hidden tabs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Notification } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { createFormatter } from '@/lib/format';
import { createI18n, translator } from '@/lib/i18n/core';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { BUSINESS_TEMPLATE_KEYS, CONSUMER_TEMPLATE_KEYS, MESSAGE_ONLY_TEMPLATE_KEYS, renderNotification, VALUE_PARAMS } from './catalog';
import { NOTIFICATION_TABS, notificationDestination, tabQuery, TAB_CATEGORIES } from './links';
import { countFailures, MAX_UNREAD_POLL_MS, UNREAD_POLL_MS, unreadPollDelay } from './polling';

const backend = join(__dirname, '../../../../backend/modules/notification/domain');

const tFor = (locale: 'en' | 'fa') => translator(createI18n(locale, BUNDLED[locale]));
const fFor = (locale: 'en' | 'fa') => createFormatter(locale, tFor(locale), 'UTC');

const n = (o: Partial<Notification>): Notification => ({
  id: '0195f3b1-6a2b-7c3d-8e4f-000000000001',
  event_type: 'system_announcement',
  category: 'system',
  priority: 'normal',
  template_key: 'system.welcome',
  template_params: {},
  locale: 'en',
  organization_context_id: null,
  reference: null,
  read_at: null,
  created_at: '2026-10-30T08:00:00Z',
  ...o,
});

describe('notification templates (drift check against the backend)', () => {
  it('classifies every backend template key exactly once', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(backend, 'templates.ts')).href)) as {
      TEMPLATES: Record<string, unknown>;
    };
    const known = [...CONSUMER_TEMPLATE_KEYS, ...BUSINESS_TEMPLATE_KEYS, ...MESSAGE_ONLY_TEMPLATE_KEYS];
    expect(new Set(known).size).toBe(known.length);
    expect([...known].sort()).toEqual(Object.keys(mod.TEMPLATES).sort());
  });

  it('knows every template key the router can put on a notification', () => {
    const routing = readFileSync(join(backend, 'routing.ts'), 'utf8');
    const used = new Set([...routing.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));
    const inApp = new Set<string>([...CONSUMER_TEMPLATE_KEYS, ...BUSINESS_TEMPLATE_KEYS]);
    // The quoted strings of routing.ts are event subjects (a.b) and template keys; the template keys must be in-app ones.
    const templateKeys = [...used].filter((k) => [...inApp].includes(k) || MESSAGE_ONLY_TEMPLATE_KEYS.includes(k as never));
    for (const k of templateKeys) expect(inApp.has(k), k).toBe(true);
    for (const k of CONSUMER_TEMPLATE_KEYS) expect(used.has(k), `${k} is routed`).toBe(true);
  });

  it('has an EN and FA title and text for every consumer key, with the backend params interpolated', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(backend, 'templates.ts')).href)) as {
      TEMPLATES: Record<string, { en: { text: string } }>;
    };
    for (const locale of ['en', 'fa'] as const) {
      const t = tFor(locale);
      for (const key of CONSUMER_TEMPLATE_KEYS) {
        const r = renderNotification({ template_key: key, template_params: {} }, t, fFor(locale));
        expect(r.known).toBe(true);
        expect(r.title, `${locale} ${key}`).not.toContain('notifications.');
        expect(r.text, `${locale} ${key}`).not.toContain('notifications.');
      }
    }
    // Each {param} of the backend's text (except links, codes and the shop name it never sends) is used by ours.
    const en = BUNDLED.en.notifications.templates as Record<string, Record<string, { text: string }>>;
    for (const key of CONSUMER_TEMPLATE_KEYS) {
      const [group, name] = key.split('.') as [string, string];
      const params = [...mod.TEMPLATES[key]!.en.text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).filter((p) => p !== 'organization_name');
      for (const p of params) expect(en[group]![name]!.text, `${key} uses {{${p}}}`).toContain(`{{${p}}}`);
    }
  });

  it('has words for every enumerated param value in both languages', () => {
    for (const locale of ['en', 'fa'] as const) {
      const values = BUNDLED[locale].notifications.values as Record<string, Record<string, string>>;
      for (const [param, list] of Object.entries(VALUE_PARAMS))
        for (const v of list) expect(values[param]?.[v], `${locale} ${param}.${v}`).toBeTruthy();
    }
  });

  it('renders params as words, numbers and dates in the UI language', () => {
    const t = tFor('fa');
    const f = fFor('fa');
    const r = renderNotification({ template_key: 'appointment.status_updated', template_params: { new_status: 'awaiting_parts' } }, t, f);
    expect(r.text).toContain('در انتظار قطعه');
    const ai = renderNotification({ template_key: 'ai.suggestion_ready', template_params: { suggestion_count: 3 } }, t, f);
    expect(ai.text).toContain('۳');
    const en = renderNotification(
      { template_key: 'appointment.reminder', template_params: { confirmed_start_at: '2026-11-02T09:30:00Z' } },
      tFor('en'),
      fFor('en'),
    );
    expect(en.text).toContain('Nov');
    // An enumerated value this build does not know falls back to plain words.
    expect(
      renderNotification({ template_key: 'inquiry.answered', template_params: { new_status: 'on_hold_soon' } }, tFor('en'), fFor('en'))
        .text,
    ).toContain('on hold soon');
  });

  it('falls back to a generic line for an unknown key', () => {
    const r = renderNotification({ template_key: 'brand.new_thing', template_params: {} }, tFor('en'), fFor('en'));
    expect(r).toEqual({ title: 'New update', text: 'Open CarPal to see what changed.', known: false });
  });
});

describe('deep links (Docs/21 §6 with web routes)', () => {
  const id = '0195f3b1-6a2b-7c3d-8e4f-0000000000aa';
  const href = (o: Partial<Notification>) => {
    const d = notificationDestination(n(o), 'fa');
    return d?.kind === 'href' ? d.href : d;
  };

  it('opens every consumer notification type at its screen or a documented placeholder', () => {
    expect(href({ template_key: 'appointment.alternative_proposed', reference: { type: 'appointment', id } })).toBe(
      `/fa/appointments/${id}`,
    );
    expect(href({ template_key: 'appointment.reminder', reference: { type: 'appointment', id } })).toBe(`/fa/appointments/${id}`);
    expect(href({ template_key: 'review.invitation_in_app', reference: { type: 'review_request', id } })).toBe('/fa/activity?tab=reviews');
    expect(href({ template_key: 'review.response_published', reference: { type: 'review', id } })).toBe('/fa/activity?tab=reviews');
    expect(href({ template_key: 'inquiry.answered', reference: { type: 'stock_inquiry', id } })).toBe(`/fa/activity/inquiries/${id}`);
    expect(href({ template_key: 'vehicle.transfer_requested', reference: { type: 'vehicle_transfer', id } })).toBe('/fa/garage');
    expect(href({ template_key: 'vehicle.transfer_decided', reference: { type: 'vehicle_transfer', id } })).toBe('/fa/garage');
    expect(href({ template_key: 'community.followed_update', reference: { type: 'post', id } })).toBe('/fa/saved?tab=following');
    expect(href({ template_key: 'moderation.action_taken', reference: { type: 'question', id } })).toBe(`/fa/questions/${id}`);
    expect(href({ template_key: 'moderation.action_taken', reference: { type: 'review', id } })).toBe('/fa/activity?tab=reports');
    expect(href({ template_key: 'system.security_alert' })).toBe('/fa/settings/security');
    expect(href({ template_key: 'system.welcome' })).toBe('/fa/garage');
    expect(href({ template_key: 'ai.suggestion_ready', reference: { type: 'ai_insight', id } })).toBe('/fa/garage');
    expect(href({ template_key: 'media.upload_refused', reference: { type: 'media_asset', id } })).toBeNull();
  });

  it('resolves a maintenance reminder through the garage', () => {
    expect(
      notificationDestination(n({ template_key: 'vehicle.reminder_due', reference: { type: 'maintenance_reminder', id } }), 'en'),
    ).toEqual({
      kind: 'reminder',
      reminderId: id,
      fallback: '/en/garage',
    });
  });
});

describe('tabs', () => {
  it('filters one category on the server and several in the browser', () => {
    expect(tabQuery('all')).toEqual({ clientFilter: null });
    expect(tabQuery('reminders')).toEqual({ category: 'service_reminders', clientFilter: null });
    expect(tabQuery('system').clientFilter).toContain('moderation');
    // Every consumer category is reachable from a tab other than All.
    const covered = new Set(NOTIFICATION_TABS.flatMap((x) => TAB_CATEGORIES[x] ?? []));
    for (const c of ['appointments', 'reviews', 'community', 'service_reminders', 'system', 'moderation', 'inquiries', 'ai_suggestions'])
      expect(covered.has(c as never), c).toBe(true);
  });
});

describe('unread-count polling', () => {
  it('polls once a minute, never before the server delay, and not in hidden tabs', () => {
    expect(unreadPollDelay({ pollAfterMs: null, failures: 0, hidden: false })).toBe(UNREAD_POLL_MS);
    expect(unreadPollDelay({ pollAfterMs: 5_000, failures: 0, hidden: false })).toBe(UNREAD_POLL_MS);
    expect(unreadPollDelay({ pollAfterMs: 180_000, failures: 0, hidden: false })).toBe(180_000);
    expect(unreadPollDelay({ pollAfterMs: null, failures: 0, hidden: true })).toBe(false);
  });

  it('backs off after consecutive failures up to 15 minutes', () => {
    expect(unreadPollDelay({ pollAfterMs: null, failures: 1, hidden: false })).toBe(2 * UNREAD_POLL_MS);
    expect(unreadPollDelay({ pollAfterMs: null, failures: 3, hidden: false })).toBe(8 * UNREAD_POLL_MS);
    expect(unreadPollDelay({ pollAfterMs: null, failures: 9, hidden: false })).toBe(MAX_UNREAD_POLL_MS);
    // A server delay longer than the cap still wins.
    expect(unreadPollDelay({ pollAfterMs: 30 * 60_000, failures: 2, hidden: false })).toBe(30 * 60_000);
  });

  it('counts each failure once and resets on success', () => {
    let s = { failures: 0, lastErrorAt: 0 };
    s = countFailures(s, { errorUpdatedAt: 100, dataUpdatedAt: 50 });
    s = countFailures(s, { errorUpdatedAt: 100, dataUpdatedAt: 50 }); // the same failure seen again
    expect(s.failures).toBe(1);
    s = countFailures(s, { errorUpdatedAt: 200, dataUpdatedAt: 50 });
    expect(s.failures).toBe(2);
    s = countFailures(s, { errorUpdatedAt: 200, dataUpdatedAt: 300 });
    expect(s.failures).toBe(0);
  });
});
