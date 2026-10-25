// Drift check (GD-17 amendment, BA-20): the PWA's typed copy of the analytics registry must equal the backend's
// CLIENT_EVENTS, which events.ingest enforces. Fails when either side adds, removes or changes an event or property.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_EVENTS, validProperties } from './events';

const backendFile = join(__dirname, '../../../../backend/modules/analytics/domain/events.ts');

describe('analytics registry', () => {
  it('matches the backend CLIENT_EVENTS exactly', async () => {
    const backend = (await import(/* @vite-ignore */ pathToFileURL(backendFile).href)) as { CLIENT_EVENTS: unknown };
    expect(JSON.parse(JSON.stringify(CLIENT_EVENTS))).toEqual(JSON.parse(JSON.stringify(backend.CLIENT_EVENTS)));
  });

  it('validates property values like the backend', () => {
    expect(validProperties('map.opened', { entry_point: 'home' })).toBe(true);
    expect(validProperties('map.opened', { entry_point: 'garage' })).toBe(false);
    expect(validProperties('map.opened', { other: 'x' })).toBe(false);
    expect(validProperties('map.pin_selected', { target_type: 'organization', rank: 3 })).toBe(true);
    expect(validProperties('map.pin_selected', { rank: 1001 })).toBe(false);
    expect(validProperties('map.directions_tapped', { navigation_app_key: 'neshan' })).toBe(true);
    expect(validProperties('map.directions_tapped', { navigation_app_key: 'Has Spaces' })).toBe(false);
    expect(validProperties('app.opened', { cold_start: 'yes' })).toBe(false);
    expect(validProperties('profile.contact_revealed', {})).toBe(false);
  });
});
