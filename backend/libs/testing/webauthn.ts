// L22 software authenticator for WebAuthn tests (GD-31): an ES256 (P-256)
// credential with "none" attestation, user verification and a signature
// counter, producing the WebAuthn Level 3 JSON a browser would send
// (RegistrationResponseJSON / AuthenticationResponseJSON). Without the backup
// flags it is a device-bound credential (a security key: aal3).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer | string): Buffer => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #key: KeyObject;
  readonly #publicJwk: { x: string; y: string };
  #counter = 0;

  constructor(
    readonly rpId = 'carpal.app',
    readonly origin = 'https://carpal.app',
    /** Synced passkey (backup eligible + backed up): multi-device, aal2 only. */
    readonly synced = false,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.#publicJwk = { x: jwk.x, y: jwk.y };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  #flags(attested: boolean): number {
    // UP (0x01) | UV (0x04) | BE (0x08) + BS (0x10) when synced | AT (0x40) when attested.
    return 0x01 | 0x04 | (this.synced ? 0x18 : 0) | (attested ? 0x40 : 0);
  }

  #counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.#counter);
    return b;
  }

  /** navigator.credentials.create(): the attestation for creation options (challenge from the server). */
  register(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, Buffer.from(this.#publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.#publicJwk.y, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.#flags(true)]),
      this.#counterBytes(),
      Buffer.alloc(16), // AAGUID (none attestation)
      idLen,
      this.credentialId,
      Buffer.from(isoCBOR.encode(cose)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
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

  /** navigator.credentials.get(): the assertion for request options. */
  assert(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    this.#counter += 1;
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([this.#flags(false)]), this.#counterBytes()]);
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
