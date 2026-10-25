import { describe, expect, it, vi } from 'vitest';
import { consentCookieString, parseConsent, readConsentCookie, serializeConsent } from './consent';
import { AnalyticsQueue, MAX_AGE_MS, MAX_BATCH, type QueuedEvent } from './queue';

function queue(o: { allowed?: boolean; send?: (e: QueuedEvent[]) => Promise<void>; now?: () => number } = {}) {
  let allowed = o.allowed ?? true;
  const sent: QueuedEvent[][] = [];
  const q = new AnalyticsQueue({
    allowed: () => allowed,
    send: o.send ?? (async (events) => void sent.push(events)),
    now: o.now,
    sessionId: 's-1',
  });
  return { q, sent, setAllowed: (v: boolean) => (allowed = v) };
}

describe('consent cookie', () => {
  it('round-trips and treats anything else as not asked', () => {
    expect(serializeConsent({ analytics: true })).toBe('v1.a1');
    expect(parseConsent('v1.a0')).toEqual({ analytics: false });
    expect(parseConsent('v0.a1')).toBeNull();
    expect(parseConsent(undefined)).toBeNull();
    expect(readConsentCookie('a=1; cp_consent=v1.a1; b=2')).toEqual({ analytics: true });
    expect(consentCookieString({ analytics: false }, true)).toMatch(/^cp_consent=v1\.a0; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/);
  });
});

describe('AnalyticsQueue', () => {
  it('records nothing without consent', async () => {
    const { q, sent } = queue({ allowed: false });
    expect(q.track('app.opened', { cold_start: true })).toBe(false);
    await q.flush();
    expect(sent).toEqual([]);
  });

  it('stamps events at capture time and sends registered ones only', async () => {
    const { q, sent } = queue({ now: () => Date.parse('2026-10-25T10:00:00Z') });
    expect(q.track('map.opened', { entry_point: 'home' })).toBe(true);
    expect(q.track('map.opened', { entry_point: 'nowhere' as 'home' })).toBe(false);
    await q.flush();
    expect(sent).toEqual([
      [
        {
          event_name: 'map.opened',
          schema_version: 1,
          occurred_at: '2026-10-25T10:00:00.000Z',
          session_id: 's-1',
          properties: { entry_point: 'home' },
        },
      ],
    ]);
    expect(q.size).toBe(0);
  });

  it('sends at most 50 per request and flushes when the queue fills', async () => {
    const { q, sent } = queue();
    for (let i = 0; i < 120; i++) q.track('app.opened');
    await q.flush();
    expect(sent.map((b) => b.length)).toEqual([MAX_BATCH, MAX_BATCH, 20]);
  });

  it('turns itself off on 501, drops refused batches, keeps events on network errors', async () => {
    const off = queue({ send: async () => Promise.reject(Object.assign(new Error('x'), { status: 501 })) });
    off.q.track('app.opened');
    await off.q.flush();
    expect(off.q.disabled).toBe(true);
    expect(off.q.track('app.opened')).toBe(false);

    const refused = queue({ send: async () => Promise.reject(Object.assign(new Error('x'), { status: 422 })) });
    refused.q.track('app.opened');
    await refused.q.flush();
    expect(refused.q.size).toBe(0);

    const send = vi.fn(async () => Promise.reject(new Error('network')));
    const flaky = queue({ send });
    flaky.q.track('app.opened');
    await flaky.q.flush();
    expect(flaky.q.size).toBe(1);
  });

  it('drops events older than 7 days and everything when consent is withdrawn', async () => {
    let now = 0;
    const { q, sent, setAllowed } = queue({ now: () => now });
    q.track('app.opened');
    now = MAX_AGE_MS + 1;
    await q.flush();
    expect(sent).toEqual([]);
    q.track('app.opened');
    setAllowed(false);
    await q.flush();
    expect(q.size).toBe(0);
  });
});
