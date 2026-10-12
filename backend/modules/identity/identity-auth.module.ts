// Authorization server operations of the identity module (40 §6.2) on the
// auth host (id.carpal.app). Needs IdentityModule in the same application.
// auth.webauthn_options and auth.social_start stay unbound (501) until
// WebAuthn and Google/Apple sign-in are built (S3 deferral).
import { Module } from '@nestjs/common';
import {
  AuthorizeHandler,
  DiscoveryHandler,
  EmailVerifyHandler,
  JwksHandler,
  MfaVerifyHandler,
  OtpStartHandler,
  OtpVerifyHandler,
  PasswordResetCompleteHandler,
  PasswordResetStartHandler,
  PowChallengeHandler,
  RevokeHandler,
  SigninPasswordHandler,
  SignupHandler,
  TokenHandler,
} from './application/auth-ops.js';
import { AuthServer } from './application/auth-server.js';

@Module({
  providers: [
    AuthServer,
    DiscoveryHandler,
    JwksHandler,
    AuthorizeHandler,
    TokenHandler,
    RevokeHandler,
    PowChallengeHandler,
    SignupHandler,
    SigninPasswordHandler,
    OtpStartHandler,
    OtpVerifyHandler,
    MfaVerifyHandler,
    EmailVerifyHandler,
    PasswordResetStartHandler,
    PasswordResetCompleteHandler,
  ],
})
export class IdentityAuthModule {}
