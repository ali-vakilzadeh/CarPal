// Response and request header rules (40 §1.2-1.4, TR-2, TR-6, TR-8).
import { ApiError } from '#libs/contract/index.js';

export const CONTRACT_VERSION = '1.0.0';

/** On every response (40 §1.4 "Security headers", TR-2). No Server / X-Powered-By. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
});

/** TR-6: method-override headers are rejected. */
export const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];

export interface ClientInfo {
  clientId: string;
  version: string;
  os: string;
  osVersion: string;
}

const CLIENT = /^([a-z0-9-]{3,40})\/(\d+\.\d+\.\d+) \(([a-z]+) ([0-9.]{1,15})\)$/;

const semver = (v: string): number[] => v.split('.').map(Number);
export function versionBelow(v: string, min: string): boolean {
  const a = semver(v);
  const b = semver(min);
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

/**
 * CarPal-Client (40 §1.3): `<client_id>/<semver> (<os> <os_version>)`. A bad
 * value is 400 MALFORMED_REQUEST; a version below the configured minimum for
 * the client is 400 CLIENT_UPGRADE_REQUIRED.
 */
export function parseClientHeader(value: string | undefined, minVersions: Readonly<Record<string, string>>): ClientInfo | undefined {
  if (value === undefined) return undefined;
  const m = CLIENT.exec(value);
  if (!m) throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Client malformed' });
  const info: ClientInfo = { clientId: m[1]!, version: m[2]!, os: m[3]!, osVersion: m[4]! };
  const min = minVersions[info.clientId];
  if (min && versionBelow(info.version, min)) throw new ApiError('CLIENT_UPGRADE_REQUIRED');
  return info;
}

let tzAllowlist: Set<string> | null = null;
/** CarPal-Timezone (40 §1.3): an IANA name from the runtime's tzdb. */
export function parseTimezone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  tzAllowlist ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (!tzAllowlist.has(value)) throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Timezone not in the tzdb allowlist' });
  return value;
}
