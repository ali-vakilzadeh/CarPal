// P4.T7: every ordinary sign-in comes back through the onboarding check; step-ups go straight back.
import { describe, expect, it } from 'vitest';
import { afterSigninPath, buildLoginUrl, safeNextPath } from './login-url';

const returnTo = (url: string) => new URL(url, 'http://x').searchParams.get('return_to');

describe('login URLs', () => {
  it('returns through /<locale>/onboarding?next=<page>', () => {
    const url = buildLoginUrl({ returnTo: '/en/shop/reza?tab=reviews', locale: 'en', screen: 'signup', intent: 'i1' });
    expect(returnTo(url)).toBe('/en/onboarding?next=%2Fen%2Fshop%2Freza%3Ftab%3Dreviews');
    const q = new URL(url, 'http://x').searchParams;
    expect([q.get('locale'), q.get('screen'), q.get('intent'), q.get('prompt')]).toEqual(['en', 'signup', 'i1', null]);
  });

  it('step-up comes straight back; switch account asks for credentials', () => {
    expect(returnTo(buildLoginUrl({ returnTo: '/fa/settings', stepUp: 'aal2' }))).toBe('/fa/settings');
    expect(new URL(buildLoginUrl({ returnTo: '/fa', switchAccount: true }), 'http://x').searchParams.get('prompt')).toBe('login');
  });

  it('keeps an onboarding return as it is and takes the locale from the path', () => {
    expect(afterSigninPath('/fa/onboarding?next=%2Ffa%2Fgarage')).toBe('/fa/onboarding?next=%2Ffa%2Fgarage');
    expect(afterSigninPath('/garage', 'en')).toBe('/en/onboarding?next=%2Fgarage');
  });

  it('accepts only same-origin app paths', () => {
    expect(safeNextPath('/fa/garage')).toBe('/fa/garage');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/bff/logout', '/api/v1/me', '/id/oauth/authorize', null, '']) {
      expect(safeNextPath(bad)).toBeNull();
    }
    expect(returnTo(buildLoginUrl({ returnTo: 'https://evil.example', locale: 'en' }))).toBe('/en/onboarding?next=%2Fen');
  });
});
