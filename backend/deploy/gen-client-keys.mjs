#!/usr/bin/env node
// Key pairs of the confidential clients (private_key_jwt at /oauth/token, GD-06 amendment 2026-11-04).
//   node gen-client-keys.mjs                 a new key file of the PWA's clients (cp-web-consumer, cp-ssr)
//   node gen-client-keys.mjs --admin         a new key file of the admin console (cp-web-admin, backend S12)
//   node gen-client-keys.mjs --public FILE…  CARPAL_OAUTH_CLIENT_JWKS of one or more key files (the backend)
//   node gen-client-keys.mjs --private FILE  the private JWKS of a key file (the PWA's CARPAL_PWA_CLIENT_PRIVATE_JWKS,
//                                            or the admin console's)
// The admin key has its own file so the PWA, which reads its key file whole, never holds the staff client's key.
// No dependencies, so it runs before the first build. The key files stay root-only in the config folder.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PWA_CLIENTS = ['cp-web-consumer', 'cp-ssr'];
const ADMIN_CLIENTS = ['cp-web-admin'];

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

const keyFile = (clients) => JSON.stringify(Object.fromEntries(clients.map((client) => [client, keyPair()])));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

const [mode, ...files] = process.argv.slice(2);
if (!mode) {
  console.log(keyFile(PWA_CLIENTS));
} else if (mode === '--admin' && files.length === 0) {
  console.log(keyFile(ADMIN_CLIENTS));
} else if (mode === '--private' && files.length === 1) {
  console.log(JSON.stringify(read(files[0])));
} else if (mode === '--public' && files.length > 0) {
  const merged = Object.assign({}, ...files.map(read));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(merged).map(([client, key]) => [client, { keys: [publicHalf(key)] }]))));
} else {
  console.error('usage: gen-client-keys.mjs [--admin | --public FILE… | --private FILE]');
  process.exit(2);
}
