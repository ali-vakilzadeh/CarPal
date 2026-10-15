// Authorization server operations of the identity module (40 §6.2) on the
// auth host (id.carpal.app). Needs IdentityModule in the same application.
// WebAuthn (GD-31) is served here; auth.social_start stays unbound (501)
// until Google/Apple sign-in is built after the MVP (OQ-06, PM-01).
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
  WebAuthnOptionsHandler,
} from './application/auth-ops.js';
import { WebAuthnService } from './application/webauthn.js';
import { AuthServer } from './application/auth-server.js';

@Module({
  providers: [
    AuthServer,
    WebAuthnService,
    WebAuthnOptionsHandler,
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
