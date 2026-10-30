// What the review pages keep in the browser (P11). Nothing here is sent anywhere except the link token and the
// invitation grant, which go back to the API in a POST body only.
//  - Link tokens across a sign-in (sessionStorage cp:link:<ri|cn>, 30 min): /l/ri and /l/cn read the token from the
//    fragment and remove it from the address bar; a guest who signs in comes back to /l/<type> without it, so the tab
//    keeps it (never in a URL, query or log; SEC-LT-2, GD-14). The opened invitation is kept with it, so returning
//    does not send another one-time code.
//  - The invitation grant (sessionStorage cp:review-grant, until its expiry ≤ 30 min): review_invitations.verify →
//    the review page, which sends it with reviews.create.
//  - Review drafts (localStorage cp:review-draft:<user>:<org>, 14 days): "Draft saved" (C-REV-01).
//  - Shop names (localStorage cp:review-orgs, ≤ 200): the author's Review names its subject by id only, so My
//    Activity shows the name this browser saw when the review was written (DI-66).
import type { ConfirmationPath, InvitationOpenView } from '@carpal/api-contracts';
import type { ReviewDraft, SubjectType } from './model';

const LINK_TTL_MS = 30 * 60_000;
const DRAFT_TTL_MS = 14 * 86_400_000;
const MAX_ORGS = 200;

function read<T>(store: Storage | undefined, key: string): T | null {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(store: Storage | undefined, key: string, value: unknown): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: the page still works for this load */
  }
}

const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

// ---------------------------------------------------------------------------------------------- link tokens

export type LinkType = 'ri' | 'cn';

interface CarriedLink {
  token: string;
  at: number;
  opened?: InvitationOpenView;
}

export function carryLink(type: LinkType, token: string, opened?: InvitationOpenView, now = Date.now()): void {
  write(session(), `cp:link:${type}`, { token, at: now, ...(opened ? { opened } : {}) } satisfies CarriedLink);
}

export function carriedLink(type: LinkType, now = Date.now()): CarriedLink | null {
  const c = read<CarriedLink>(session(), `cp:link:${type}`);
  if (!c || typeof c.token !== 'string' || now - c.at > LINK_TTL_MS) return null;
  return c;
}

export function dropLink(type: LinkType): void {
  write(session(), `cp:link:${type}`, null);
}

// ---------------------------------------------------------------------------------------------- invitation grant

export interface StoredGrant {
  orgId: string;
  slug: string;
  name: string;
  subject: SubjectType;
  grant: string;
  expiresAt: string;
  path: ConfirmationPath;
  visit: InvitationOpenView['visit_context'] | null;
}

export function saveGrant(g: StoredGrant): void {
  write(session(), 'cp:review-grant', g);
}

/** The grant for this organization while it is valid (30 minutes from verify). */
export function grantFor(orgId: string, now = Date.now()): StoredGrant | null {
  const g = read<StoredGrant>(session(), 'cp:review-grant');
  if (!g || g.orgId !== orgId || Date.parse(g.expiresAt) <= now) return null;
  return g;
}

export function dropGrant(): void {
  write(session(), 'cp:review-grant', null);
}

// ---------------------------------------------------------------------------------------------- drafts

interface StoredDraft {
  draft: ReviewDraft;
  at: number;
}

const draftKey = (userId: string, key: string) => `cp:review-draft:${userId}:${key}`;

export function saveDraft(userId: string, key: string, draft: ReviewDraft, now = Date.now()): void {
  write(local(), draftKey(userId, key), { draft, at: now } satisfies StoredDraft);
}

export function readDraft(userId: string, key: string, now = Date.now()): ReviewDraft | null {
  const d = read<StoredDraft>(local(), draftKey(userId, key));
  if (!d || now - d.at > DRAFT_TTL_MS || typeof d.draft?.body !== 'string') return null;
  return d.draft;
}

export function dropDraft(userId: string, key: string): void {
  write(local(), draftKey(userId, key), null);
}

// ---------------------------------------------------------------------------------------------- shop names

export interface KnownOrg {
  name: string;
  slug: string | null;
  as: SubjectType;
}

export function rememberOrg(id: string, org: KnownOrg): void {
  const all = read<Record<string, KnownOrg>>(local(), 'cp:review-orgs') ?? {};
  delete all[id];
  const next = Object.fromEntries([...Object.entries(all), [id, org]].slice(-MAX_ORGS));
  write(local(), 'cp:review-orgs', next);
}

export function knownOrgs(): Record<string, KnownOrg> {
  return parseKnownOrgs(knownOrgsSnapshot());
}

/** The stored names as a string (a stable snapshot for useBrowserValue). */
export function knownOrgsSnapshot(): string {
  try {
    return local()?.getItem('cp:review-orgs') ?? '';
  } catch {
    return '';
  }
}

export function parseKnownOrgs(raw: string): Record<string, KnownOrg> {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, KnownOrg>) : {};
  } catch {
    return {};
  }
}
