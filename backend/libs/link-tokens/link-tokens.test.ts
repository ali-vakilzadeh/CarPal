import { describe, expect, it } from 'vitest';
import { CryptoServices } from '#libs/crypto/index.js';
import { assertRecipient, consumeFailure, LinkTokens } from './index.js';

const links = new LinkTokens(new CryptoServices('test-master-secret-0123456789-abcdefghij').hmac);

describe('link tokens (SEC-LT)', () => {
  it('issues 256-bit cp_<type>_ tokens, stores only the HMAC and puts them in fragments', () => {
    const now = Date.UTC(2026, 9, 10);
    const t = links.issue('pr', now);
    expect(t.token).toMatch(/^cp_pr_[A-Za-z0-9_-]{43}$/);
    expect(t.hash).toHaveLength(32);
    expect(t.hash.equals(links.hash(t.token))).toBe(true);
    expect(t.expiresAt?.getTime()).toBe(now + 30 * 60_000);
    expect(links.issue('ci').expiresAt).toBeNull();
    expect(links.link('ev', 'cp_ev_x')).toBe('https://carpal.app/l/ev#cp_ev_x');
  });

  it('treats malformed and foreign tokens like unknown ones (410, no oracle)', () => {
    const t = links.issue('mi');
    expect(links.parse(t.token, 'mi').hash.equals(t.hash)).toBe(true);
    expect(() => links.parse(t.token, 'ev')).toThrow(expect.objectContaining({ code: 'LINK_EXPIRED', status: 410 }));
    expect(() => links.parse('cp_mi_short', 'mi')).toThrow(expect.objectContaining({ code: 'LINK_EXPIRED' }));
    expect(consumeFailure(undefined).code).toBe('LINK_EXPIRED');
    expect(consumeFailure({ used_at: new Date() }).code).toBe('LINK_USED');
    expect(consumeFailure({ used_at: null }).code).toBe('LINK_EXPIRED');
  });

  it('binds tokens to their recipient (SEC-LT-5)', () => {
    expect(() => assertRecipient({ email: 'A@x.io' }, { userId: 'u1', verifiedEmail: 'a@x.io' })).not.toThrow();
    expect(() => assertRecipient({ userId: 'u1' }, { userId: 'u1' })).not.toThrow();
    expect(() => assertRecipient({ email: 'a@x.io' }, { userId: 'u2', verifiedEmail: null })).toThrow(
      expect.objectContaining({ code: 'LINK_RECIPIENT_MISMATCH' }),
    );
  });
});
