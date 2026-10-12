// ATT verification (40 SEC-MOB-3, SEC-BF-7), used by the Authenticator in
// strict mode (CARPAL_STRICT_AUTH=1). Proof of work: `CarPal-PoW:
// <challenge_id>.<nonce>` must solve a challenge from auth.pow_challenge
// (SHA-256(prefix + nonce) with the required leading zero bits); each
// challenge is single use. Platform attestation (App Attest, Play Integrity)
// needs the vendors' verification services: not available in lite mode, so
// attestation tokens are refused and clients use the PoW fallback (S3
// deviation).
import { Injectable } from '@nestjs/common';
import { AttestationVerifierPort } from '#libs/runtime/index.js';
import { leadingZeroBits } from '../domain/credentials.js';
import { AuthState } from './auth-state.js';

const POW = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{1,64})$/;

@Injectable()
export class PowAttestationVerifier extends AttestationVerifierPort {
  constructor(private readonly state: AuthState) {
    super();
  }

  async verify(input: { attestation?: string; pow?: string; clientId?: string; opId: string }): Promise<boolean> {
    if (!input.pow) return false;
    const m = POW.exec(input.pow);
    if (!m) return false;
    const challenge = await this.state.takePow(m[1]!);
    return !!challenge && leadingZeroBits(challenge.prefix, m[2]!) >= challenge.bits;
  }
}
