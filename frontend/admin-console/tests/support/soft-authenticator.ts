// A software security key for the integration tests (AC3.T7), after backend/libs/testing/webauthn.ts: an ES256 (P-256)
// credential with "none" attestation, user verification and a signature counter, producing the WebAuthn Level 3 JSON
// a browser sends. Without the backup flags (BE/BS) the backend counts it as device-bound (SEC-ADM-2, aal3). A minimal
// CBOR encoder replaces @simplewebauthn/server, which the console does not depend on. Test code only.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** RFC 8949 encoding of the few types an attestation object and a COSE key need. */
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, item] of v) parts.push(cbor(k), cbor(item));
  return Buffer.concat(parts);
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #key: KeyObject;
  readonly #x: Buffer;
  readonly #y: Buffer;
  #counter = 0;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.#x = Buffer.from(jwk.x, 'base64url');
    this.#y = Buffer.from(jwk.y, 'base64url');
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  #counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.#counter);
    return b;
  }

  /** navigator.credentials.create() for creation options from the server. */
  register(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const cose = new Map<number, Cbor>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, this.#x],
      [-3, this.#y],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    // UP | UV | AT; no BE/BS: a device-bound credential.
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x01 | 0x04 | 0x40]),
      this.#counterBytes(),
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      cbor(cose),
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: String(options.challenge), origin: this.origin, crossOrigin: false }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['usb'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'cross-platform',
    };
  }

  /** navigator.credentials.get() for request options from the server. */
  assert(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    this.#counter += 1;
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), this.#counterBytes()]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: String(options.challenge), origin: this.origin, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.#key);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: null,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'cross-platform',
    };
  }
}

/** Proof of work for ATT operations in strict mode (SEC-BF-7): SHA-256(prefix + nonce) with `bits` leading zero bits. */
export function solvePow(prefix: string, bits: number): string {
  for (let i = 0; ; i++) {
    const h = sha256(prefix + String(i));
    let zeros = 0;
    for (const byte of h) {
      if (byte === 0) {
        zeros += 8;
        continue;
      }
      zeros += Math.clz32(byte) - 24;
      break;
    }
    if (zeros >= bits) return String(i);
  }
}
