// What this browser remembers about the signed-in user's community activity (P8). The contract tells nobody whether
// they wrote a question, answer or comment, or whether they already reacted (PublicQuestion/PublicAnswer/Comment
// carry a display name only, SEC-OUT-3; DI-50). So the PWA keeps, per user and per browser (localStorage, ≤ 500
// entries each, never sent anywhere): the ids of what they posted here, the reactions they gave here, and the
// display name the backend shows for them. The server still decides every write (a delete or accept on someone
// else's content answers 404). Safe to call on the server (no-op).

export type MineKind = 'question' | 'answer' | 'comment';

const MAX = 500;
const key = (userId: string, what: string) => `cp:community:${what}:${userId}`;

function read(k: string): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(k);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(k: string, list: string[]): void {
  try {
    localStorage.setItem(k, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* storage blocked or full: the feature degrades to the display-name match */
  }
}

export function rememberMine(userId: string, kind: MineKind, id: string, authorName?: string): void {
  const k = key(userId, kind);
  const list = read(k).filter((x) => x !== id);
  write(k, [...list, id]);
  if (authorName) {
    try {
      localStorage.setItem(key(userId, 'name'), authorName);
    } catch {
      /* ignore */
    }
  }
}

export function forgetMine(userId: string, kind: MineKind, id: string): void {
  const k = key(userId, kind);
  write(
    k,
    read(k).filter((x) => x !== id),
  );
}

/** The ids of `kind` this user posted from this browser. */
export function mineIds(userId: string | null | undefined, kind: MineKind): Set<string> {
  return userId ? new Set(read(key(userId, kind))) : new Set();
}

/** The public author name the backend showed for this user (learned from their own posts), or null. */
export function knownAuthorName(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(key(userId, 'name'));
  } catch {
    return null;
  }
}

/**
 * Likely written by the signed-in user: posted from this browser, or shown under their author name (the display name
 * of the session, or the name the backend used for their earlier posts). Display names are not unique, so this only
 * decides which buttons to show; the server checks.
 */
export function looksMine(
  user: { id: string; display_name: string } | null | undefined,
  kind: MineKind,
  item: { id: string; author: { display_name: string } },
): boolean {
  if (!user) return false;
  if (mineIds(user.id, kind).has(item.id)) return true;
  const name = item.author.display_name.trim();
  return name !== '' && (name === user.display_name.trim() || name === knownAuthorName(user.id));
}

// ---------------------------------------------------------------------------------------------- reactions

const reactionKey = (type: string, targetType: string, id: string) => `${type}:${targetType}:${id}`;

export function reactedHere(userId: string | null | undefined, type: string, targetType: string, id: string): boolean {
  return userId ? read(key(userId, 'reactions')).includes(reactionKey(type, targetType, id)) : false;
}

export function rememberReaction(userId: string, type: string, targetType: string, id: string, on: boolean): void {
  const k = key(userId, 'reactions');
  const rk = reactionKey(type, targetType, id);
  const list = read(k).filter((x) => x !== rk);
  write(k, on ? [...list, rk] : list);
}
