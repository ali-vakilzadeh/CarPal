// What the hosted sign-in keeps in this browser:
// - "Keep me signed in" off → cp_keep=0 for the BFF callback (a browser-session cookie, P4.T2);
// - the last sign-in method, remembered per device (Docs/21 S-AUTH-02);
// - the sign-up form while the visitor leaves and returns (everything but the password, S-AUTH-03);
// - the optional sign-up choices (marketing, AI personalisation). auth.signup takes no consents, so they are granted
//   with consents.grant once the new account is signed in (onboarding applies them, DI-30).
// Every access is wrapped: storage may be unavailable (private windows, blocked site data).

export const KEEP_COOKIE = 'cp_keep';
const METHOD_KEY = 'cp:signin-method';
const DRAFT_KEY = 'cp:signup-draft';
const CHOICES_KEY = 'cp:signup-choices';
/** Choices older than this are dropped (the interaction itself lasts 30 minutes). */
const CHOICES_TTL_MS = 60 * 60_000;

export function setKeepSignedIn(keep: boolean): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = keep
    ? `${KEEP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
    : `${KEEP_COOKIE}=0; Path=/; Max-Age=1800; SameSite=Lax${secure}`;
}

export type SigninMethod = 'code' | 'password';

export function lastMethod(): SigninMethod | null {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    return v === 'code' || v === 'password' ? v : null;
  } catch {
    return null;
  }
}

export function rememberMethod(method: SigninMethod): void {
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    // not remembered
  }
}

export interface SignupDraft {
  fullName: string;
  email: string;
  phone: string;
}

export function loadSignupDraft(): Partial<SignupDraft> {
  try {
    const v = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<SignupDraft>;
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    return {};
  }
}

export function saveSignupDraft(draft: SignupDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // not kept
  }
}

export function clearSignupDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing to clear
  }
}

export interface SignupChoices {
  marketing: boolean;
  aiPersonalization: boolean;
  /** The privacy policy version the boxes were shown with (policy_version of the consent records). */
  policyVersion: string;
  at: number;
}

export function saveSignupChoices(c: Omit<SignupChoices, 'at'>): void {
  try {
    if (c.marketing || c.aiPersonalization) sessionStorage.setItem(CHOICES_KEY, JSON.stringify({ ...c, at: Date.now() }));
    else sessionStorage.removeItem(CHOICES_KEY);
  } catch {
    // the boxes are offered again in settings (P9)
  }
}

/** Takes the pending choices once (null when there are none or they are too old). */
export function takeSignupChoices(now = Date.now()): SignupChoices | null {
  try {
    const raw = sessionStorage.getItem(CHOICES_KEY);
    sessionStorage.removeItem(CHOICES_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as SignupChoices;
    if (typeof c.at !== 'number' || c.at + CHOICES_TTL_MS < now || typeof c.policyVersion !== 'string') return null;
    return { marketing: c.marketing === true, aiPersonalization: c.aiPersonalization === true, policyVersion: c.policyVersion, at: c.at };
  } catch {
    return null;
  }
}
