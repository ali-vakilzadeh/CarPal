import { describe, expect, it } from 'vitest';
import { activeItem, LEFT_NAV, switchLocalePath, TABS } from './nav-items';
import { SUGGEST_TYPES } from './search-box';

describe('search suggestions', () => {
  it('ask for at most 5 taxonomy types (contract: Set<TaxonomyType,5>)', () => {
    expect(SUGGEST_TYPES.length).toBeLessThanOrEqual(5);
    expect(new Set(SUGGEST_TYPES).size).toBe(SUGGEST_TYPES.length);
  });
});

describe('nav items', () => {
  it('finds the active destination below the locale', () => {
    expect(activeItem(LEFT_NAV, '/fa/garage')).toBe('garage');
    expect(activeItem(LEFT_NAV, '/en/garage/123/history')).toBe('garage');
    expect(activeItem(LEFT_NAV, '/fa/garages')).toBeNull();
    expect(activeItem(LEFT_NAV, '/fa')).toBeNull();
    expect(activeItem(TABS, '/fa/home')).toBe('discover');
  });

  it('keeps path and query when switching language', () => {
    expect(switchLocalePath('/fa/garage', 'tab=docs', 'en')).toBe('/en/garage?tab=docs');
    expect(switchLocalePath('/en', '', 'fa')).toBe('/fa');
    expect(switchLocalePath('/fa/search', '?modal=filters', 'en')).toBe('/en/search?modal=filters');
  });

  it('left navigation follows Docs/22 §2.3 order; the tab bar has Help Me in the middle', () => {
    expect(LEFT_NAV.map((i) => i.id)).toEqual([
      'home',
      'discover',
      'garage',
      'help',
      'appointments',
      'questions',
      'saved',
      'notifications',
      'settings',
    ]);
    expect(TABS[2]?.id).toBe('help');
  });
});
