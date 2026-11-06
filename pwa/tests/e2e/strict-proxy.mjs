// Strict-mode helper for the E2E suites (backend S11): the test helpers call the backend directly to seed shops and read
// public data, and in strict mode those calls need a client assertion and DPoP proofs like any BFF. This proxy adds them,
// so the specs stay unchanged. The PWA under test never goes through it: it talks to the strict backend itself.
//   node tests/e2e/strict-proxy.mjs
// Environment: CARPAL_PWA_CLIENT_PRIVATE_JWKS (the private keys), CARPAL_ISSUER, CARPAL_API_AUDIENCE; then run the suites
// with CARPAL_E2E_API_URL=http://127.0.0.1:8180 CARPAL_E2E_AUTH_URL=http://127.0.0.1:8182. pwa/README.md "Strict mode".
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';

const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const ISSUER = process.env.CARPAL_ISSUER ?? 'https://id.carpals.ir';
const AUDIENCE = process.env.CARPAL_API_AUDIENCE ?? 'https://api.carpals.ir';
const keys = JSON.parse(process.env.CARPAL_PWA_CLIENT_PRIVATE_JWKS ?? '{}');

const dpop = await generateKeyPair('ES256');
const dpopJwk = await exportJWK(dpop.publicKey);
let nonce;

async function proof(method, url, accessToken) {
  const claims = { htm: method, htu: url, jti: randomUUID() };
  if (nonce && !accessToken) claims.nonce = nonce;
  if (accessToken) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk }).setIssuedAt().sign(dpop.privateKey);
}

async function assertion(clientId) {
  const key = keys[clientId];
  if (!key) return undefined;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: randomUUID() })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(`${ISSUER}/oauth/token`)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(await importJWK(key, 'ES256'));
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

function forwardHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length'].includes(k)) headers[k] = v;
  return headers;
}

async function reply(res, upstream) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) headers[k] = v;
  });
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(upstream.status, headers);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function token(body, headers) {
  const form = new URLSearchParams(body.toString('utf8'));
  const send = async () => {
    const signed = await assertion(form.get('client_id'));
    if (signed) {
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', signed);
    }
    return fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', dpop: await proof('POST', `${ISSUER}/oauth/token`) },
      body: form.toString(),
      redirect: 'manual',
    });
  };
  let res = await send();
  const given = res.headers.get('dpop-nonce');
  if (given) nonce = given;
  if (
    res.status === 400 &&
    (
      await res
        .clone()
        .json()
        .catch(() => ({}))
    ).error === 'use_dpop_nonce'
  )
    res = await send();
  return res;
}

function listen(port, handle) {
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      res.writeHead(502);
      res.end();
    });
  }).listen(port, '127.0.0.1');
}

listen(8182, async (req, res) => {
  const body = await readBody(req);
  const headers = forwardHeaders(req);
  if (req.method === 'POST' && req.url === '/oauth/token') return reply(res, await token(body, headers));
  return reply(
    res,
    await fetch(`${AUTH}${req.url}`, { method: req.method, headers, redirect: 'manual', ...(body.length ? { body } : {}) }),
  );
});

listen(8180, async (req, res) => {
  const body = await readBody(req);
  const headers = forwardHeaders(req);
  const bound = /^DPoP (.+)$/.exec(headers.authorization ?? '');
  if (bound) headers.dpop = await proof(req.method, `${AUDIENCE}${req.url.split('?')[0]}`, bound[1]);
  return reply(res, await fetch(`${API}${req.url}`, { method: req.method, headers, redirect: 'manual', ...(body.length ? { body } : {}) }));
});

console.warn('strict proxy: api :8180, auth :8182');
