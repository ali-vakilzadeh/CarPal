// The boot script (P3.T3): the Trusted Types default policy and the pre-paint theme for "automatic". The only
// inline script of the app: a constant string from src/lib/theme.ts, carrying the request's CSP nonce. Lint allows
// dangerouslySetInnerHTML in this file only for that reason (eslint.config.js); never put request or API data here.
import { BOOT_SCRIPT } from '@/lib/theme';

export function ThemeBootScript({ nonce }: { nonce: string | undefined }) {
  // The browser hides the nonce attribute after parsing, so the hydrated value differs by design.
  return <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />;
}
