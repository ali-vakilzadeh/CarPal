// W-AUTH-01 full page "/login" (Docs/22): starts the hosted sign-in (src/server/start-signin.ts).
import { startSignin, type SigninPageProps } from '@/server/start-signin';

export default async function LoginPage(props: SigninPageProps) {
  return startSignin(props);
}
