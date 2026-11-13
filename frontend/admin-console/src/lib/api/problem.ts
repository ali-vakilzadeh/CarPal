// Typed API errors (AC3.T5), adapted from pwa/src/lib/api/problem.ts: problem+json from admin-api or the BFF becomes an
// ApiProblem with the contract's Problem members (40 §4.2), so screens branch on fields instead of parsing text. Admin
// additions: the step-up challenge (GD-11), separation of duties (SELF_APPROVAL_FORBIDDEN), the purpose a PURP read
// needs (GD-10; refused by this client before sending), and the version preconditions (VERSION_MISMATCH 412,
// PRECONDITION_REQUIRED 428).
import type { ERROR_CODES, FieldError } from '@carpal/api-contracts';

/** Contract error codes plus the ones the BFF and this client add. */
export type ApiErrorCode =
  | keyof typeof ERROR_CODES
  | 'CSRF_FAILED'
  | 'SESSION_ENDED'
  | 'SIGNIN_FAILED'
  | 'BAD_GATEWAY'
  | 'NETWORK'
  | 'PAUSED'
  | 'PURPOSE_REQUIRED'
  | (string & {});

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
  /** 401 STEP_UP_REQUIRED: sign in again with the passkey (/bff/reauth), then replay the action (GD-11). */
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
    this.stepUp = code === 'STEP_UP_REQUIRED' ? parseStepUp(o.wwwAuthenticate ?? null) : null;
    this.body = body;
  }

  /** The field error at an RFC 6901 pointer (e.g. '/reason'). */
  field(pointer: string): FieldError | undefined {
    return this.fields.find((f) => f.pointer === pointer);
  }

  /** The staff session is gone (idle, absolute end, revoked): sign in again. */
  get signedOut(): boolean {
    return this.code === 'SESSION_ENDED' || this.code === 'UNAUTHENTICATED';
  }

  /** SEC-ADM-6: the same staff member cannot approve their own change or decide their own case; explained, not an error (GD-11). */
  get selfApproval(): boolean {
    return this.code === 'SELF_APPROVAL_FORBIDDEN';
  }

  /** 412/428: someone changed the record meanwhile, or the write needs If-Match; reload without losing the input. */
  get preconditionFailed(): boolean {
    return this.code === 'VERSION_MISMATCH' || this.code === 'PRECONDITION_REQUIRED';
  }

  /** 403: the work item (purpose) is the caller's, but this record is not one of its subjects (backend S14, SEC-ADM-5). */
  get purposeMismatch(): boolean {
    return this.code === 'PURPOSE_RECORD_MISMATCH';
  }

  /** A purpose-bound read (PURP) was opened without a work item (GD-10). */
  get purposeRequired(): boolean {
    return this.code === 'PURPOSE_REQUIRED';
  }

  /** 403 the staff role does not allow this (GD-09: the UI hid it, the server still decides). */
  get forbidden(): boolean {
    return this.status === 403 && (this.code === 'FORBIDDEN' || this.code === 'HTTP_403');
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** RFC 9470 challenge: `DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600`. */
export function parseStepUp(header: string | null): StepUpChallenge {
  const acr = /acr_values="?(aal[23])"?/.exec(header ?? '')?.[1] as 'aal2' | 'aal3' | undefined;
  const maxAge = /max_age="?(\d+)"?/.exec(header ?? '')?.[1];
  // Staff sessions are aal3 on every request (SEC-ADM-2): without a readable challenge, ask for aal3.
  return { acrValues: acr ?? 'aal3', maxAgeS: maxAge ? Number(maxAge) : null };
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
