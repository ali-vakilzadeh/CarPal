// Read interface for discovery (S6) and trust scoring (S7): the active
// capability matrix of providers, in the caller's RLS context (members see
// all of their own; other contexts see the public_read rows only).
import type { TxScope } from '#libs/tenancy/index.js';

export interface CapabilityRecord {
  id: string;
  providerOrganizationId: string;
  brandNodeId: string | null;
  modelNodeId: string | null;
  seriesNodeId: string | null;
  serviceSystemNodeId: string;
  serviceTaskNodeId: string | null;
  experienceLevel: string;
  confidenceLevel: string;
  confidenceScore: number;
  evidenceCount: number;
  publicVisibility: boolean;
  badgeEligible: boolean;
}

export abstract class ProviderCapabilities {
  /** Active capabilities of the providers (≤ 500 organizations per call). */
  abstract forProviders(scope: TxScope, orgIds: readonly string[]): Promise<CapabilityRecord[]>;
}
