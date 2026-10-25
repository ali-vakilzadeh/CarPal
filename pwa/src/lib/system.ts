// W-SYS-01 system page kinds and their HTTP status (shared by the proxy and the page; no React here).
export const SYSTEM_KINDS = ['not-found', 'gone', 'suspended', 'no-access', 'maintenance'] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

export const SYSTEM_STATUS: Record<SystemKind, number> = {
  'not-found': 404,
  gone: 410,
  suspended: 200,
  'no-access': 403,
  maintenance: 503,
};

export function isSystemKind(value: unknown): value is SystemKind {
  return typeof value === 'string' && (SYSTEM_KINDS as readonly string[]).includes(value);
}
