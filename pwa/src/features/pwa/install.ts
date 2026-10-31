// The install prompt rule (Docs/22 §2.5, P12.T1): a small "Install CarPal" button appears in the header after the
// second signed-in visit, can be dismissed, and is not shown again for 30 days. A visit is one browser session (a
// tab opened anew), counted once while signed in. The browser decides whether the app is installable at all: the
// button needs its beforeinstallprompt event (Chromium); Safari has none, so nothing is shown there (out of scope).
// Pure functions over a small stored record; features/pwa/install-prompt.tsx keeps it in localStorage.

export const INSTALL_STORE_KEY = 'cp:pwa:install';
export const VISIT_SESSION_KEY = 'cp:pwa:visit-counted';
export const QUIET_DAYS = 30;
export const VISITS_BEFORE_PROMPT = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstallRecord {
  /** Signed-in visits counted so far. */
  visits: number;
  /** When the prompt was last dismissed (ms since epoch), or null. */
  dismissedAt: number | null;
  /** The app was installed from this browser. */
  installed: boolean;
}

export const EMPTY_INSTALL_RECORD: InstallRecord = { visits: 0, dismissedAt: null, installed: false };

export function parseInstallRecord(raw: string | null): InstallRecord {
  if (!raw) return EMPTY_INSTALL_RECORD;
  try {
    const o = JSON.parse(raw) as Partial<InstallRecord>;
    return {
      visits: Number.isInteger(o.visits) && o.visits! >= 0 ? Math.min(o.visits!, 1000) : 0,
      dismissedAt: typeof o.dismissedAt === 'number' && Number.isFinite(o.dismissedAt) ? o.dismissedAt : null,
      installed: o.installed === true,
    };
  } catch {
    return EMPTY_INSTALL_RECORD;
  }
}

/** One more signed-in visit (call once per browser session). */
export function withVisit(r: InstallRecord): InstallRecord {
  return { ...r, visits: Math.min(r.visits + 1, 1000) };
}

export function withDismissal(r: InstallRecord, now: number): InstallRecord {
  return { ...r, dismissedAt: now };
}

export function withInstalled(r: InstallRecord): InstallRecord {
  return { ...r, installed: true };
}

/** Whether the header shows the install button. */
export function shouldOfferInstall(
  r: InstallRecord,
  o: { now: number; installable: boolean; standalone: boolean; signedIn: boolean },
): boolean {
  if (!o.signedIn || !o.installable || o.standalone || r.installed) return false;
  if (r.visits < VISITS_BEFORE_PROMPT) return false;
  return r.dismissedAt === null || o.now - r.dismissedAt >= QUIET_DAYS * DAY_MS;
}
