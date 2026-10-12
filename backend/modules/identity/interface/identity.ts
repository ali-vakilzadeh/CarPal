// Public interface of the identity module (41 §4.2 interface/). The consent
// gate is the platform port libs/consent-gate ConsentChecker and role
// resolution the platform port libs/authz MembershipDirectory, both
// implemented by this module. Other modules read user display cards here,
// plug into consent scopes and DSR export delivery, manage organization
// memberships (organization module, 40 §7) and open consent requests.
import type { TxScope } from '#libs/tenancy/index.js';

/** Public-safe card of a user (identity.user_cards): never contact data (40 SEC-OUT-3). */
export interface UserCard {
  id: string;
  /** Null after anonymization (DSR deletion). */
  displayName: string | null;
  status: string;
}

export abstract class UserCards {
  abstract cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, UserCard>>;
}

/** Scope entity types of 52 ConsentRecord.scope_entity_type. */
export type ConsentScopeType = 'vehicle' | 'appointment' | 'media_asset' | 'portfolio_item' | 'stock_inquiry';

/**
 * Checks that a consent scope entity exists and belongs to the user granting
 * the consent (SEC-AZ-4). Registered by the owning module (vehicle: S5,
 * appointment: S7, media and portfolio: S4, inquiries: S5). An unregistered
 * scope type cannot be granted (fail closed, 422 REFERENCE_NOT_FOUND).
 */
export type ConsentScopeVerifier = (scope: TxScope, userId: string, entityId: string) => Promise<boolean>;

export class ConsentScopes {
  readonly #verifiers = new Map<ConsentScopeType, ConsentScopeVerifier>();

  register(type: ConsentScopeType, verifier: ConsentScopeVerifier): void {
    if (this.#verifiers.has(type)) throw new Error(`consent scope ${type} registered twice`);
    this.#verifiers.set(type, verifier);
  }

  get(type: string): ConsentScopeVerifier | undefined {
    return this.#verifiers.get(type as ConsentScopeType);
  }
}

/**
 * Delivery of DSR export bundles (S8 builds them as media assets; the media
 * module, S4, signs URLs). Until bound, completed exports have no file.
 */
export abstract class DataExportFiles {
  /** A 5-minute signed download URL, or null when the file is gone or expired. */
  abstract signedUrl(scope: TxScope, mediaAssetId: string): Promise<{ url: string; expiresAt: Date } | null>;
  /** True while the file can still be downloaded. */
  abstract available(scope: TxScope, mediaAssetId: string): Promise<boolean>;
}

export class NoDataExportFiles extends DataExportFiles {
  async signedUrl(): Promise<null> {
    return null;
  }
  async available(): Promise<boolean> {
    return false;
  }
}

/** Facts about the signed-in user's own account (self_read context). */
export abstract class AccountFacts {
  /** 52 §4 verified contact: a verified email or phone (403 VERIFIED_CONTACT_REQUIRED otherwise). */
  abstract hasVerifiedContact(scope: TxScope, userId: string): Promise<boolean>;
}

/** A role membership of an organization (40 §7.1 OrgMember source). User fields are null for pending invitations. */
export interface OrgMemberRecord {
  membershipId: string;
  version: number;
  userId: string | null;
  fullName: string | null;
  displayName: string | null;
  /** The member's email, or the invited address of a pending invitation. */
  email: string;
  role: string;
  status: 'invited' | 'active' | 'suspended' | 'removed';
  joinedAt: Date | null;
}

export interface MemberListQuery {
  role?: string;
  status?: string;
  /** Keyset position (membership id, ascending). */
  afterId?: string;
  limit: number;
}

/**
 * Organization memberships (identity.role_memberships), used by the
 * organization module for 40 §7 member operations. Calls run in the caller's
 * transaction with the organization context set (policy self_or_org).
 */
export abstract class OrgMemberships {
  /** The creator of a new organization becomes its active owner. */
  abstract addOwner(scope: TxScope, orgId: string, userId: string, role: string): Promise<void>;
  abstract list(scope: TxScope, orgId: string, q: MemberListQuery): Promise<OrgMemberRecord[]>;
  abstract get(scope: TxScope, orgId: string, membershipId: string, lock?: boolean): Promise<OrgMemberRecord | null>;
  /** Live (invited, active or suspended) membership of a user, or of an invited email. */
  abstract findLive(scope: TxScope, orgId: string, by: { userId: string } | { email: string }): Promise<OrgMemberRecord | null>;
  /** A pending invitation bound to one email and role, stored as the HMAC of its mi token (SEC-LT). */
  abstract invite(
    scope: TxScope,
    orgId: string,
    i: { email: string; role: string; invitedBy: string; tokenHash: Buffer; expiresAt: Date },
  ): Promise<string>;
  abstract update(scope: TxScope, membershipId: string, patch: { role?: string; status?: string }): Promise<OrgMemberRecord>;
  /** Active memberships with one of `roles`, optionally without one membership. */
  abstract countActive(scope: TxScope, orgId: string, roles: readonly string[], excludingId?: string): Promise<number>;
  /**
   * org.invitation_accept (identity.accept_invitation, definer): consumes the
   * invitation of an mi token hash for the signed-in user (verified email
   * must match, SEC-LT-5) and returns the 40 Membership view.
   */
  abstract acceptInvitation(scope: TxScope, tokenHash: Buffer): Promise<{ membershipId: string; orgId: string; membership: unknown }>;
}

export interface ConsentRequestInput {
  organizationId: string;
  requestedByUserId: string;
  subjectUserId: string;
  consentType: 'showcase_publishing' | 'photo_publishing';
  scope: { type: ConsentScopeType; id: string };
  sourceVisit: { type: 'appointment' | 'service_record'; id: string };
  purposeI18nKey: string;
  /** Organization name shown in the mail (the link view shows the full card). */
  organizationName: string;
}

/**
 * Consent requests by cn link (52 ConsentRequest, 40 consents.request_view /
 * respond). A business opens one for a customer it derived from a visit;
 * identity owns the table and the response flow. Calls run in the business's
 * organization context (policy party_all).
 */
export abstract class ConsentRequests {
  /**
   * Issues a single-use cn link (14 days), stores only its HMAC and mails the
   * link to the subject after commit (the caller never sees the token or the
   * subject's contact data). 409 DUPLICATE when one is already pending for the
   * same subject, type and scope.
   */
  abstract create(scope: TxScope, r: ConsentRequestInput): Promise<{ id: string; expiresAt: Date }>;
  /** The newest request of this organization for a scope entity and consent type. */
  abstract latest(
    scope: TxScope,
    organizationId: string,
    consentType: string,
    scopeRef: { type: string; id: string },
  ): Promise<{ id: string; status: string; resultingConsentId: string | null; expiresAt: Date } | null>;
}
