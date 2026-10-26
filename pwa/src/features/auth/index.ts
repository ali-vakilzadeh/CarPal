// Hosted sign-in UI and link-token pages (P4, W-AUTH-01): src/app/id/signin and src/app/l/[type] render these.
export { HostedSignIn, RESEND_AFTER_S, type HostedSignInProps } from './hosted-sign-in';
export { EmailVerifyPage, PasswordResetPage } from './link-pages';
export { takeSignupChoices, type SignupChoices } from './storage';
export { maskDestination, normalizePhone, parseIdentifier, type Identifier } from './identifier';
export { checkPassword, passwordError, PASSWORD_MAX, PASSWORD_MIN } from './password';
