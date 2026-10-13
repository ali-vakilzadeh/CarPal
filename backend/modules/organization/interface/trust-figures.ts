// Organization-owned records of trust scoring (54; W3 trust-scoring in the
// trust module, S7). The trust module decides what counts and computes every
// number (54 §1-§6); this interface reads the organization's own evidence
// sources and stores the results where 54 §10 puts them: capability evidence
// rows (immutable once counted, revoked when the source no longer counts),
// capability confidence, Organization.trust_score and
// ProviderProfile.activity_status. Worker use, system context.
import type { TxScope } from '#libs/tenancy/index.js';

export type EvidenceType = 'completed_appointment' | 'verified_review' | 'portfolio_item' | 'service_record' | 'certification' | 'job_log';
export type EvidenceRefType = 'appointment' | 'review' | 'portfolio_item' | 'service_record' | 'certification' | 'job_log';

/** One evidence item as the trust module wants it counted (52 ProviderCapabilityEvidence, linked_by system_rule). */
export interface EvidenceItem {
  evidenceType: EvidenceType;
  referenceType: EvidenceRefType;
  referenceId: string;
  /** 54 §1.1 base weight (reviews: rating weight × trust weight, rounded). */
  baseWeight: number;
  /** YYYY-MM-DD, the freshness date (54 §6). */
  evidenceDate: string;
  brandNodeId: string | null;
  modelNodeId: string | null;
  seriesNodeId: string | null;
  /** Null for a brand-only certification. */
  serviceSystemNodeId: string | null;
  serviceTaskNodeId: string | null;
  /** Ids of records describing the same real-world job (appointment, service record): 54 §1.1 no double counting. */
  sameJobAs?: string[];
}

/** An active evidence row after the sync, with the capability it is linked to. */
export interface LinkedEvidence extends EvidenceItem {
  id: string;
  capabilityId: string;
}

export interface CapabilityScore {
  capabilityId: string;
  confidenceLevel: 'self_declared' | 'low_evidence' | 'moderate_evidence' | 'strong_evidence' | 'verified_expert';
  confidenceScore: number;
  evidenceCount: number;
  badgeEligible: boolean;
}

/** Inputs of 54 §3 profile integrity and §4 badge rules owned by the organization module. */
export interface OrgTrustFacts {
  orgId: string;
  organizationType: string;
  status: string;
  verificationStatus: string;
  trustScore: number | null;
  createdAt: Date;
  /** 52 OrganizationVerification types currently verified (business_identity, location …). */
  verifiedTypes: string[];
  provider: { profileCompleteness: number; activityStatus: string; publicStatus: string; createdAt: Date } | null;
  vendor: {
    profileCompleteness: number;
    catalogQualityScore: number;
    measuredResponseTimeMinutes: number | null;
    publicStatus: string;
  } | null;
  activeLocations: number;
  verifiedLocations: number;
  /** Active certifications (all types: trade licenses count toward profile integrity, 54 §1.1). */
  certifications: { id: string; type: string; verified: boolean; scopeNodeIds: string[]; expiresAt: string | null }[];
}

/** A provider job log as a review invitation visit (52 ReviewRequest.provider_job_log_id). */
export interface JobLogVisit {
  id: string;
  vehicleId: string | null;
  jobDate: string;
  serviceSystemNodeId: string;
  serviceTaskNodeId: string | null;
}

export abstract class TrustFigures {
  /** An active job log of the provider in the caller's context (the provider's members), else null. */
  abstract jobLog(scope: TxScope, orgId: string, jobLogId: string): Promise<JobLogVisit | null>;
  /** Null for unknown organizations. */
  abstract facts(scope: TxScope, orgId: string): Promise<OrgTrustFacts | null>;
  /**
   * Evidence the organization module owns, as it counts today (54 §1.1):
   * published portfolio items (5), job logs not self_reported (3, with the
   * linked appointment / service record as sameJobAs) and verified
   * manufacturer, industry and ev_high_voltage certifications (15).
   */
  abstract ownEvidence(scope: TxScope, orgId: string): Promise<EvidenceItem[]>;
  /**
   * Makes the organization's system_rule evidence match `items`: missing
   * items are inserted (status active) and linked to the most specific
   * active capability of the provider whose taxonomy they fit (a
   * certification to every capability of its brand or system); without one,
   * a system-level capability is created (source job_evidence /
   * review_evidence / certification, not public). Active rows no longer in
   * `items` are revoked (54 §9: never edited, never restored). Returns the
   * active evidence after the sync.
   */
  abstract syncEvidence(scope: TxScope, orgId: string, items: readonly EvidenceItem[]): Promise<LinkedEvidence[]>;
  /** Writes confidence figures that changed; returns the number of capabilities updated. */
  abstract recordCapabilityScores(scope: TxScope, orgId: string, scores: readonly CapabilityScore[]): Promise<number>;
  /** Writes Organization.trust_score when it changed; returns the previous value. */
  abstract recordTrustScore(scope: TxScope, orgId: string, score: number | null): Promise<{ changed: boolean; previous: number | null }>;
  /**
   * Writes ProviderProfile.activity_status (54 §6 staleness) and
   * measured_response_time_minutes (appointment requests) when they changed;
   * true when the row changed (it moves the profile's version).
   */
  abstract recordProviderFigures(
    scope: TxScope,
    orgId: string,
    f: { activityStatus?: 'active' | 'inactive'; measuredResponseTimeMinutes?: number | null },
  ): Promise<boolean>;
}
