// Typed copy of the backend's client analytics registry (backend/modules/analytics/domain/events.ts CLIENT_EVENTS,
// GD-17 amendment, BA-20). events.ingest drops an event whose name, property or value is not registered, so the
// PWA only lets registered ones through the type system; events.test.ts compares this copy with the backend file.
// Values are closed vocabularies — never free text, ids of people or coordinates.
type PropertySpec =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'bool' }
  | { readonly kind: 'int'; readonly min: number; readonly max: number }
  | { readonly kind: 'key' };

export const ENTRY_POINTS = [
  'home',
  'search',
  'map',
  'help_me',
  'discover',
  'profile',
  'vehicle',
  'notification',
  'deep_link',
  'other',
] as const;
export const TARGETS = ['organization', 'inventory_item', 'location'] as const;

export const CLIENT_EVENTS = {
  'map.opened': { entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'map.pin_selected': { target_type: { kind: 'enum', values: TARGETS }, rank: { kind: 'int', min: 0, max: 1000 } },
  'map.vehicle_filter_toggled': { enabled: { kind: 'bool' }, show_all_nearby: { kind: 'bool' } },
  'map.directions_tapped': { navigation_app_key: { kind: 'key' }, target_type: { kind: 'enum', values: TARGETS } },
  'search.started': { entry_point: { kind: 'enum', values: ENTRY_POINTS }, help_me_used: { kind: 'bool' } },
  'search.safety_banner_shown': { entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'search.chip_edited': { chip_type: { kind: 'key' } },
  'search.result_opened': { target_type: { kind: 'enum', values: TARGETS }, rank: { kind: 'int', min: 0, max: 1000 } },
  'profile.viewed': { target_type: { kind: 'enum', values: ['provider', 'vendor'] }, entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'app.opened': { cold_start: { kind: 'bool' } },
  'onboarding.step_completed': {
    flow_type: { kind: 'enum', values: ['individual', 'fleet', 'provider', 'vendor'] },
    step: { kind: 'key' },
  },
} as const satisfies Record<string, Record<string, PropertySpec>>;

export type EventName = keyof typeof CLIENT_EVENTS;

type ValueOf<S> = S extends { kind: 'enum'; values: readonly (infer V)[] }
  ? V
  : S extends { kind: 'bool' }
    ? boolean
    : S extends { kind: 'int' }
      ? number
      : string;

export type EventProperties<N extends EventName> = { [K in keyof (typeof CLIENT_EVENTS)[N]]?: ValueOf<(typeof CLIENT_EVENTS)[N][K]> };

const KEY = /^[a-z0-9_.-]{1,40}$/;

/** Mirrors the backend's validateClientEvent value rules, so the queue never sends an event the API would drop. */
export function validProperties(name: string, props: Record<string, unknown>): boolean {
  const spec = (CLIENT_EVENTS as Record<string, Record<string, PropertySpec>>)[name];
  if (!spec) return false;
  return Object.entries(props).every(([k, v]) => {
    const p = spec[k];
    if (!p) return false;
    if (p.kind === 'bool') return typeof v === 'boolean';
    if (p.kind === 'int') return Number.isInteger(v) && (v as number) >= p.min && (v as number) <= p.max;
    if (p.kind === 'enum') return typeof v === 'string' && p.values.includes(v);
    return typeof v === 'string' && KEY.test(v);
  });
}
