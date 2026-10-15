// Account, consent, DSR and onboarding operations of the identity module
// (40 §6.3-§6.6) on the api host. Needs IdentityModule, BillingModule and
// OrganizationModule (global) in the same application.
import { Module } from '@nestjs/common';
import {
  MeEmailChangeHandler,
  MeGetHandler,
  MePasswordChangeHandler,
  MePhoneChangeStartHandler,
  MePhoneChangeVerifyHandler,
  MePreferencesGetHandler,
  MePreferencesUpdateHandler,
  MeUpdateHandler,
} from './application/account-ops.js';
import { MeReader } from './application/common.js';
import {
  ConsentRequestRespondHandler,
  ConsentRequestViewHandler,
  ConsentsGrantHandler,
  ConsentsListHandler,
  ConsentsWithdrawHandler,
  ConsentWriter,
  OrgConsentsGrantHandler,
  OrgConsentsListHandler,
  OrgConsentsWithdrawHandler,
} from './application/consent-ops.js';
import {
  DsrCreateHandler,
  DsrExportDownloadHandler,
  DsrGetHandler,
  DsrListHandler,
  DsrViews,
  OnboardingAcceptTermsHandler,
  OnboardingListHandler,
  OnboardingUpdateHandler,
} from './application/privacy-ops.js';
import {
  MembershipLeaveHandler,
  MembershipsListHandler,
  MfaConfirmHandler,
  MfaListHandler,
  MfaRemoveHandler,
  MfaTotpEnrollHandler,
  WebAuthnRegisterOptionsHandler,
  RecoveryCodesRegenerateHandler,
  SessionRevokeHandler,
  SessionsListHandler,
  SessionsRevokeAllHandler,
} from './application/security-ops.js';
import { WebAuthnService } from './application/webauthn.js';

@Module({
  providers: [
    MeReader,
    ConsentWriter,
    DsrViews,
    MeGetHandler,
    MeUpdateHandler,
    MeEmailChangeHandler,
    MePhoneChangeStartHandler,
    MePhoneChangeVerifyHandler,
    MePasswordChangeHandler,
    MePreferencesGetHandler,
    MePreferencesUpdateHandler,
    MembershipsListHandler,
    MembershipLeaveHandler,
    SessionsListHandler,
    SessionRevokeHandler,
    SessionsRevokeAllHandler,
    MfaListHandler,
    MfaTotpEnrollHandler,
    WebAuthnRegisterOptionsHandler,
    WebAuthnService,
    MfaConfirmHandler,
    MfaRemoveHandler,
    RecoveryCodesRegenerateHandler,
    ConsentsListHandler,
    ConsentsGrantHandler,
    ConsentsWithdrawHandler,
    ConsentRequestViewHandler,
    ConsentRequestRespondHandler,
    OrgConsentsListHandler,
    OrgConsentsGrantHandler,
    OrgConsentsWithdrawHandler,
    DsrCreateHandler,
    DsrListHandler,
    DsrGetHandler,
    DsrExportDownloadHandler,
    OnboardingListHandler,
    OnboardingUpdateHandler,
    OnboardingAcceptTermsHandler,
  ],
})
export class IdentityAccountModule {}
