// L4 authz (41 §2.2): guards from the contract's sec tags, role resolution
// from server state (≤ 30 s cache), 404-not-403.
export { Authorizer, aliasOrgTypes, rolesFor, type AccessGrant, type AuthorizeInput, type AuthorizerOptions } from './authorizer.js';
export {
  DriverAssignments,
  MembershipDirectory,
  OrganizationDirectory,
  PurposeVerifier,
  type AccessPurpose,
  type Membership,
  type OrganizationInfo,
  type PurposeKind,
} from './ports.js';
export { EmptyDirectory, InMemoryDirectory, NoDriverAssignments, WellFormedPurposeVerifier } from './stubs.js';
