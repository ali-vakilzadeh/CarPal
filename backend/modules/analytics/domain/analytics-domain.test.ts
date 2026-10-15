import { describe, expect, it } from 'vitest';
import { countMetric, dec4, DASHBOARDS, forwardedProperties, pseudonym, validateClientEvent } from './events.js';

const now = Date.parse('2026-10-15T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

describe('client event registry (events.ingest)', () => {
  it('accepts registered names with registered properties only', () => {
    expect(
      validateClientEvent(
        { event_name: 'map.pin_selected', schema_version: 1, occurred_at: at(now), properties: { target_type: 'organization', rank: 3 } },
        now,
      ),
    ).toEqual({
      target_type: 'organization',
      rank: 3,
    });
    expect(validateClientEvent({ event_name: 'map.opened', schema_version: 1, occurred_at: at(now) }, now)).toEqual({});
    expect(validateClientEvent({ event_name: 'unknown.event', schema_version: 1, occurred_at: at(now) }, now)).toBeNull();
    // Unknown property, wrong type, out of range, free text in a key field.
    expect(
      validateClientEvent({ event_name: 'map.opened', schema_version: 1, occurred_at: at(now), properties: { email: 'a@b.c' } }, now),
    ).toBeNull();
    expect(
      validateClientEvent(
        { event_name: 'map.vehicle_filter_toggled', schema_version: 1, occurred_at: at(now), properties: { enabled: 'yes' } },
        now,
      ),
    ).toBeNull();
    expect(
      validateClientEvent({ event_name: 'map.pin_selected', schema_version: 1, occurred_at: at(now), properties: { rank: 5000 } }, now),
    ).toBeNull();
    expect(
      validateClientEvent(
        {
          event_name: 'map.directions_tapped',
          schema_version: 1,
          occurred_at: at(now),
          properties: { navigation_app_key: 'Ali Street 5' },
        },
        now,
      ),
    ).toBeNull();
  });

  it('refuses clock skew beyond 5 minutes ahead or 7 days back', () => {
    expect(validateClientEvent({ event_name: 'app.opened', schema_version: 1, occurred_at: at(now + 10 * 60_000) }, now)).toBeNull();
    expect(validateClientEvent({ event_name: 'app.opened', schema_version: 1, occurred_at: at(now - 8 * 86_400_000) }, now)).toBeNull();
    expect(validateClientEvent({ event_name: 'app.opened', schema_version: 1, occurred_at: at(now - 86_400_000) }, now)).toEqual({});
  });

  it('keeps only non-personal payload keys of forwarded domain events', () => {
    expect(
      forwardedProperties('appointment.requested', {
        source: 'ai_match',
        requester_type: 'user',
        requester_user_id: 'u',
        description: 'text',
      }),
    ).toEqual({
      source: 'ai_match',
      requester_type: 'user',
    });
    expect(forwardedProperties('review.published', { overall_rating: 4, author_user_id: 'x' })).toEqual({ overall_rating: 4 });
  });

  it('pseudonyms are keyed HMACs: stable per key, unlinkable without it', () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const id = '0190a3b4-0000-7000-8000-000000000001';
    expect(pseudonym(k1, id)).toMatch(/^[0-9a-f]{64}$/);
    expect(pseudonym(k1, id)).toBe(pseudonym(k1, id));
    expect(pseudonym(k2, id)).not.toBe(pseudonym(k1, id));
  });

  it('dashboards list metric keys of the daily_metrics format', () => {
    for (const keys of Object.values(DASHBOARDS)) for (const k of keys) expect(k).toMatch(/^[a-z0-9_.]{1,80}$/);
    expect(countMetric('map.opened')).toBe('events.map.opened');
    expect(dec4(1.234567)).toBe('1.2346');
    expect(dec4(-3)).toBe('0');
  });
});
