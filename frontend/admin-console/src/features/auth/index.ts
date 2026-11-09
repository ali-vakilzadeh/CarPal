// Staff sign-in (AC4, A-AUTH-01): the page component and what other areas need from it.
export { StaffSignIn, type StaffSignInProps } from './staff-sign-in';
export { authOutcome, isSigninOutcome, outcomeMessage, SIGNIN_OUTCOMES, type AuthOutcome, type SigninOutcome } from './problems';
export { createAuthClient, browserPow, authPath, type AuthClient, type AuthOperationId } from './auth-client';
