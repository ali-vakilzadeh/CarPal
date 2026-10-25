// Typed API errors (GD-09): problem+json from the API or the BFF becomes an ApiProblem with the contract's Problem
// members (40 §4.2), so screens branch on fields instead of parsing text (BA-03).
import type { ConsentType, ERROR_CODES, FieldError, Problem } from '@carpal/api-contracts';

/** Contract error codes plus the ones the BFF and this client add. */
export type ApiErrorCode =
  keyof typeof ERROR_CODES | 'CSRF_FAILED' | 'SESSION_ENDED' | 'SIGNIN_FAILED' | 'BAD_GATEWAY' | 'NETWORK' | 'PAUSED' | (string & {});

export interface StepUpChallenge {
  acrValues: 'aal2' | 'aal3';
  maxAgeS: number | null;
}

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly title: string;
  readonly requestId: string | null;
  readonly fields: readonly FieldError[];
  /** Milliseconds the server asked to wait (429/503, SEC-RL-1); also set when the client paused the operation. */
  readonly retryAfterMs: number | null;
  readonly requirements: readonly string[];
  readonly consentType: ConsentType | null;
  readonly entitlementKey: string | null;
  readonly safety: Problem['safety'] | null;
  readonly fallbackPath: string | null;
  readonly vinTransferAvailable: boolean;
  /** 401 STEP_UP_REQUIRED: sign in again at this level (BA-11). */
  readonly stepUp: StepUpChallenge | null;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>, o: { wwwAuthenticate?: string | null; retryAfterMs?: number | null } = {}) {
    const code = typeof body.code === 'string' ? body.code : status === 0 ? 'NETWORK' : `HTTP_${status}`;
    super(`${status} ${code}`);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
    this.title = typeof body.title === 'string' ? body.title : '';
    this.requestId = typeof body.request_id === 'string' ? body.request_id : null;
    this.fields = Array.isArray(body.errors) ? (body.errors as FieldError[]) : [];
    const bodyRetry = typeof body.retry_after_ms === 'number' ? body.retry_after_ms : null;
    this.retryAfterMs = o.retryAfterMs ?? bodyRetry;
    this.requirements = Array.isArray(body.requirements) ? (body.requirements as string[]) : [];
    this.consentType = typeof body.consent_type === 'string' ? (body.consent_type as ConsentType) : null;
    this.entitlementKey = typeof body.entitlement_key === 'string' ? body.entitlement_key : null;
    this.safety = typeof body.safety === 'object' && body.safety !== null ? (body.safety as Problem['safety']) : null;
    this.fallbackPath = typeof body.fallback_path === 'string' ? body.fallback_path : null;
    this.vinTransferAvailable = body.vin_transfer_available === true;
    this.stepUp = code === 'STEP_UP_REQUIRED' ? parseStepUp(o.wwwAuthenticate ?? null) : null;
    this.body = body;
  }

  /** The field error at an RFC 6901 pointer (e.g. '/vin'). */
  field(pointer: string): FieldError | undefined {
    return this.fields.find((f) => f.pointer === pointer);
  }

  /** 412: someone changed the resource meanwhile; reload without losing the user's input (GD-09 amendment 5). */
  get versionMismatch(): boolean {
    return this.code === 'VERSION_MISMATCH';
  }

  /** 429 with a wait the client does not sleep on (> 30 s, e.g. the appointment request caps, BA-19). */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** RFC 9470 challenge: `DPoP error="insufficient_user_authentication", acr_values="aal2", max_age=600`. */
export function parseStepUp(header: string | null): StepUpChallenge {
  const acr = /acr_values="?(aal[23])"?/.exec(header ?? '')?.[1] as 'aal2' | 'aal3' | undefined;
  const maxAge = /max_age="?(\d+)"?/.exec(header ?? '')?.[1];
  return { acrValues: acr ?? 'aal2', maxAgeS: maxAge ? Number(maxAge) : null };
}

/** Builds an ApiProblem from a failed response (problem+json, RFC 6749 JSON or anything else). */
export async function problemFrom(res: Response): Promise<ApiProblem> {
  let body: Record<string, unknown> = {};
  try {
    const text = await res.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (typeof body.code !== 'string' && typeof body.error === 'string') body = { ...body, code: body.error };
  const header = Number(res.headers.get('carpal-retry-after-ms') ?? NaN);
  return new ApiProblem(res.status, body, {
    wwwAuthenticate: res.headers.get('www-authenticate'),
    retryAfterMs: Number.isFinite(header) ? header : null,
  });
}
