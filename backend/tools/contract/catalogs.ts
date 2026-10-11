// Small catalogs read from Docs/40 besides operations and types:
// error codes (§4.3, §4.4), role groups (§0.5) and the contract version.
import { lines, tableAt, ticks, type Line } from './markdown.js';

export interface ErrorCodeInfo {
  code: string;
  status: number;
  meaning: string;
  /** true for the implicit errors of §4.3 (apply to every operation). */
  common: boolean;
}

export function parseErrorCatalog(doc: string): ErrorCodeInfo[] {
  const all = lines(doc);
  const out = new Map<string, ErrorCodeInfo>();
  // §4.3: "`400 MALFORMED_REQUEST` · `401 UNAUTHENTICATED` · ..."
  const commonLine = all.find((l) => /^`\d{3} [A-Z_]+`( · `\d{3} [A-Z_]+`)+/.test(l.text));
  if (!commonLine) throw new Error('40 §4.3 common error line not found');
  for (const t of ticks(commonLine.text).filter((x) => /^\d{3} [A-Z_]+$/.test(x))) {
    const [status, code] = t.split(' ');
    out.set(code!, { code: code!, status: Number(status), meaning: '', common: true });
  }
  // §4.4 table: | Code | Status | Meaning |
  const header = all.findIndex((l) => /^\| Code \| Status \| Meaning \|/.test(l.text));
  if (header < 0) throw new Error('40 §4.4 error table not found');
  for (const [code, status, meaning] of tableAt(all, header).slice(1)) {
    const c = ticks(code ?? '')[0];
    if (!c) continue;
    const prev = out.get(c);
    out.set(c, { code: c, status: Number(status), meaning: meaning ?? '', common: prev?.common ?? false });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export interface RoleGroup {
  /** Role names of 52 RoleMembership.role. */
  roles: string[];
  /** O+ / M+: only the roles that belong to the path organization's type apply. */
  orgTypeRelative?: boolean;
  /** ANY: every active member role of the path organization. */
  anyMember?: boolean;
}

export function parseRoleGroups(doc: string): Record<string, RoleGroup> {
  const all: Line[] = lines(doc);
  const header = all.findIndex((l) => /^\| Group \| Roles/.test(l.text));
  if (header < 0) throw new Error('40 §0.5 role group table not found');
  const out: Record<string, RoleGroup> = {};
  for (const [groupCell, rolesCell] of tableAt(all, header).slice(1)) {
    const names = ticks(groupCell ?? '');
    const roles = (rolesCell ?? '').match(/\b(?:individual|(?:fleet|provider|vendor|platform)_[a-z_]+)\b/g) ?? [];
    if (names.length > 1) {
      // `ADM` `MOD` `SUP` `CRV` | platform_admin, platform_moderator, ...: pairwise.
      if (names.length !== roles.length) throw new Error(`Role group row ${names.join(' ')} does not pair with its roles`);
      names.forEach((n, i) => (out[n] = { roles: [roles[i]!] }));
      continue;
    }
    const name = names[0];
    if (!name) continue;
    if (name === 'ANY') out[name] = { roles: [], anyMember: true };
    else out[name] = { roles, ...(/of the org type/.test(rolesCell ?? '') ? { orgTypeRelative: true } : {}) };
  }
  return out;
}

export function parseContractVersion(doc: string): string {
  const m = /\*\*Contract version:\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(doc);
  if (!m) throw new Error('Contract version not found in 40 header');
  return m[1]!;
}
