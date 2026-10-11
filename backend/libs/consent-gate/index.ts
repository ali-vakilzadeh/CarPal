// L16 consent gate (41 §2.2; 40 §0.4 CNS, SEC-AZ-8): shared data is read only
// while the needed consent is granted, checked on every read inside the
// transaction and never cached, so a withdrawal takes effect on the next
// request. The identity module implements ConsentChecker (S3); until then the
// default answers "no consent" (fail closed).
import { ApiError } from '#libs/contract/index.js';
import type { ConsentType } from '#libs/contract/generated/enums.js';
import type { TxScope } from '#libs/tenancy/index.js';

export interface ConsentQuery {
  consentType: ConsentType;
  /** Whose consent: a user or an organization (org.consents_*). */
  subject: { type: 'user' | 'organization'; id: string };
  /** The record the consent is scoped to, when the consent type is scoped (e.g. a vehicle). */
  scopeEntity?: { type: string; id: string };
  /** Who receives the data (e.g. the provider organization), when the consent names one. */
  grantee?: { type: 'user' | 'organization'; id: string };
}

export abstract class ConsentChecker {
  abstract isGranted(scope: TxScope, query: ConsentQuery): Promise<boolean>;
}

export class NoConsentChecker extends ConsentChecker {
  async isGranted(): Promise<boolean> {
    return false;
  }
}

/** CNS(type): 403 CONSENT_REQUIRED when the consent is missing or withdrawn. */
export async function requireConsent(checker: ConsentChecker, scope: TxScope, query: ConsentQuery): Promise<void> {
  if (!(await checker.isGranted(scope, query))) throw new ApiError('CONSENT_REQUIRED', { detail: `consent ${query.consentType} missing` });
}
