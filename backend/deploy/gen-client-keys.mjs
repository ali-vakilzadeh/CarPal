#!/usr/bin/env node
// Key pairs of the confidential clients (private_key_jwt at /oauth/token, GD-06 amendment 2026-11-04).
//   node gen-client-keys.mjs                 prints a new key file (JSON) to stdout
//   node gen-client-keys.mjs --public FILE   CARPAL_OAUTH_CLIENT_JWKS of a key file (the backend)
//   node gen-client-keys.mjs --private FILE  CARPAL_PWA_CLIENT_PRIVATE_JWKS of a key file (the PWA)
// No dependencies, so it runs before the first build. The key file stays root-only in the config folder.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CLIENTS = ['cp-web-consumer', 'cp-ssr'];

function keyPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  // RFC 7638 thumbprint as the key id.
  const kid = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
  return { ...jwk, kid, alg: 'ES256', use: 'sig' };
}

const publicHalf = ({ d: _private, ...key }) => key;

const [mode, file] = process.argv.slice(2);
if (!mode) {
  console.log(JSON.stringify(Object.fromEntries(CLIENTS.map((client) => [client, keyPair()]))));
} else if ((mode === '--public' || mode === '--private') && file) {
  const keys = JSON.parse(readFileSync(file, 'utf8'));
  console.log(
    JSON.stringify(
      mode === '--private' ? keys : Object.fromEntries(Object.entries(keys).map(([client, key]) => [client, { keys: [publicHalf(key)] }])),
    ),
  );
} else {
  console.error('usage: gen-client-keys.mjs [--public FILE | --private FILE]');
  process.exit(2);
}
