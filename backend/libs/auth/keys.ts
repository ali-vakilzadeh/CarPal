// Access-token signing keys (40 SEC-AU-2, §2.17): EdDSA (Ed25519) only, kid
// required, published as JWKS by the auth server (auth.jwks). Keys rotate
// every 90 days with two keys published during the overlap: the first key of
// the ring signs, all keys verify.
import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { KeyRing } from '#libs/crypto/index.js';

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

export class JwtKeyRing {
  readonly #keys: SigningKey[];

  constructor(keys: SigningKey[]) {
    if (keys.length === 0) throw new Error('JWT key ring is empty');
    for (const k of keys) {
      if (k.privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`JWT key ${k.kid} is not Ed25519 (EdDSA only, SEC-AU-2)`);
    }
    this.#keys = keys;
  }

  /** Derived from the master secret (dev and derived-key deployments). */
  static derived(keys: KeyRing, kids: string[] = ['cp-ed25519-1']): JwtKeyRing {
    return new JwtKeyRing(kids.map((kid) => ({ kid, ...keys.ed25519(`jwt:${kid}`) })));
  }

  /** From private Ed25519 JWKs (JSON array with kid), e.g. CARPAL_JWT_PRIVATE_JWKS from the secret manager. */
  static fromPrivateJwks(json: string): JwtKeyRing {
    const list = JSON.parse(json) as (JsonWebKey & { kid?: string })[];
    if (!Array.isArray(list)) throw new Error('CARPAL_JWT_PRIVATE_JWKS must be a JSON array of JWKs');
    return new JwtKeyRing(
      list.map((jwk) => {
        if (!jwk.kid) throw new Error('every JWT signing JWK needs a kid');
        const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
        return { kid: jwk.kid, privateKey, publicKey: createPublicKey(privateKey) };
      }),
    );
  }

  get active(): SigningKey {
    return this.#keys[0]!;
  }

  publicKey(kid: string): KeyObject | undefined {
    return this.#keys.find((k) => k.kid === kid)?.publicKey;
  }

  /** JWKS document (auth.jwks): public parts only. */
  jwks(): { keys: PublicJwk[] } {
    return {
      keys: this.#keys.map((k) => {
        const jwk = k.publicKey.export({ format: 'jwk' }) as { x: string };
        return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: k.kid, alg: 'EdDSA', use: 'sig' };
      }),
    };
  }
}
