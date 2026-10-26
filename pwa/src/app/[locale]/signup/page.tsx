// W-AUTH-01 full page "/signup" (Docs/22): starts the hosted sign-in on account creation (src/server/start-signin.ts).
import { startSignin, type SigninPageProps } from '@/server/start-signin';

export default async function SignupPage(props: SigninPageProps) {
  return startSignin(props, 'signup');
}
