// SMTP mailer (backend S26a.T2) against a local SMTP test server (smtp-server, with its built-in self-signed
// certificate): implicit TLS and login, STARTTLS required, Persian subjects and the Message-ID, the retry classes
// (4xx temporary, 5xx permanent), the hourly cap order, and the certificate check outside dev.
import { afterEach, describe, expect, it } from 'vitest';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { smtpUrlProblem } from '#libs/config/index.js';
import { MemoryKeyValueStore, SendError, SmtpMailer, type SmtpMailerOptions } from './index.js';

interface Received {
  from: string;
  to: string[];
  raw: string;
  user: string | undefined;
  secure: boolean;
}

const servers: SMTPServer[] = [];
const mailers: SmtpMailer[] = [];
afterEach(async () => {
  for (const m of mailers.splice(0)) m.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A local server; `answer` decides each message (null: accept). */
async function server(o: Partial<SMTPServerOptions> & { answer?: () => { code: number; text: string } | null } = {}) {
  const received: Received[] = [];
  const { answer, ...opts } = o;
  const s = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'no-reply@carpals.test' && auth.password === 'p@ss:word/1') cb(null, { user: auth.username });
      else cb(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const refusal = answer?.();
        if (refusal) return cb(Object.assign(new Error(refusal.text), { responseCode: refusal.code }));
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          user: session.user as string | undefined,
          secure: session.secure,
        });
        cb();
      });
    },
    ...opts,
  });
  // A client that refuses the certificate drops the socket: the server reports it, the test expects it.
  s.on('error', () => undefined);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.server.address() as { port: number }).port;
  return { received, port };
}

function mailer(url: string, o: Partial<SmtpMailerOptions> = {}): SmtpMailer {
  const m = new SmtpMailer({
    url,
    from: 'CarPal <no-reply@carpals.test>',
    replyTo: null,
    maxPerHour: 300,
    env: 'dev',
    tlsInsecure: true,
    kv: new MemoryKeyValueStore(),
    ...o,
  });
  mailers.push(m);
  return m;
}

const LOGIN = 'no-reply%40carpals.test:p%40ss%3Aword%2F1';
const message = { to: 'person@example.com', template: 'identity.otp_code', locale: 'fa', variables: { code: '123456' } };

describe('SmtpMailer', () => {
  it('sends over implicit TLS with the mailbox login, a Persian subject and a Message-ID on the sending domain', async () => {
    const srv = await server({ secure: true });
    const m = mailer(`smtps://${LOGIN}@127.0.0.1:${srv.port}`);
    const r = await m.send({ ...message, subject: 'کد ورود شما', text: 'کد شما 123456 است.' });
    expect(srv.received).toHaveLength(1);
    const got = srv.received[0]!;
    expect(got).toMatchObject({ from: 'no-reply@carpals.test', to: ['person@example.com'], user: 'no-reply@carpals.test', secure: true });
    expect(got.raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(got.raw).toMatch(/^Message-ID: <[0-9a-f-]{36}@carpals\.test>/m);
    expect(got.raw).toMatch(/^X-CarPal-Template: identity\.otp_code/im);
    expect(got.raw).not.toMatch(/List-Unsubscribe/i);
    expect(r.providerMessageId).toMatch(/@carpals\.test>$/);
  });

  it('adds List-Unsubscribe only to optional mail', async () => {
    const srv = await server({ secure: true });
    const m = mailer(`smtps://${LOGIN}@127.0.0.1:${srv.port}`);
    await m.send({ ...message, template: 'notification.digest', unsubscribeUrl: 'https://pwa.carpals.ir/settings/notifications' });
    expect(srv.received[0]!.raw).toMatch(/^List-Unsubscribe: <https:\/\/pwa\.carpals\.ir\/settings\/notifications>/m);
  });

  it('upgrades smtp:// with STARTTLS, and refuses a server that does not offer it (never plain)', async () => {
    const tls = await server({ secure: false });
    // The server offers STARTTLS: the client upgrades before it logs in.
    const viaTls = mailer(`smtp://${LOGIN}@127.0.0.1:${tls.port}`);
    await viaTls.send(message);
    expect(tls.received.at(-1)!.secure).toBe(true);

    const plain = await server({ secure: false, hideSTARTTLS: true, allowInsecureAuth: true });
    const strict = mailer(`smtp://${LOGIN}@127.0.0.1:${plain.port}`, { env: 'staging', tlsInsecure: false });
    const err = await strict.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).permanent).toBe(false);
    expect(plain.received).toHaveLength(0);
  });

  it('refuses a certificate that does not verify outside dev', async () => {
    const srv = await server({ secure: true });
    const m = mailer(`smtps://${LOGIN}@127.0.0.1:${srv.port}`, { env: 'prod', tlsInsecure: true });
    await expect(m.send(message)).rejects.toBeInstanceOf(SendError);
    expect(srv.received).toHaveLength(0);
  });

  it('maps a 4xx answer to a temporary failure and a 5xx answer to a permanent one; a wrong login is temporary', async () => {
    let next: { code: number; text: string } | null = { code: 451, text: 'Try again later' };
    const srv = await server({ secure: true, answer: () => next });
    const m = mailer(`smtps://${LOGIN}@127.0.0.1:${srv.port}`);
    const temp = await m.send(message).catch((e: unknown) => e);
    expect(temp).toBeInstanceOf(SendError);
    expect((temp as SendError).permanent).toBe(false);
    next = { code: 550, text: 'Mailbox unavailable' };
    const perm = await m.send(message).catch((e: unknown) => e);
    expect((perm as SendError).permanent).toBe(true);
    next = null;
    await m.send(message);
    expect(srv.received).toHaveLength(1);

    const bad = mailer(`smtps://no-reply%40carpals.test:wrong@127.0.0.1:${srv.port}`);
    const auth = await bad.send(message).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(SendError);
    expect((auth as SendError).permanent).toBe(false);
    expect((auth as Error).message).not.toContain('wrong');
  });

  it('holds deferrable mail above the hourly cap until the next hour; codes and security notices still go', async () => {
    const srv = await server({ secure: true });
    const now = new Date('2026-11-17T08:20:00Z');
    const m = mailer(`smtps://${LOGIN}@127.0.0.1:${srv.port}`, { maxPerHour: 2, now: () => now });
    await m.send({ ...message, template: 'review.received', deferrable: true });
    await m.send({ ...message, template: 'review.received', deferrable: true });
    const held = await m.send({ ...message, template: 'review.received', deferrable: true }).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(SendError);
    expect((held as SendError).retryAt?.toISOString()).toBe('2026-11-17T09:00:00.000Z');
    await m.send(message); // the sign-in code is not deferrable
    expect(srv.received.map((r) => r.raw.match(/X-CarPal-Template: (\S+)/i)![1])).toEqual([
      'review.received',
      'review.received',
      'identity.otp_code',
    ]);
  });
});

describe('SMTP URL rule (CARPAL_SMTP_URL)', () => {
  it('accepts smtps:// and smtp:// with a login outside dev, and refuses the rest', () => {
    expect(smtpUrlProblem('smtps://u:p@mail.carpals.ir:465', 'prod')).toBeNull();
    expect(smtpUrlProblem('smtp://u:p@mail.carpals.ir:587', 'staging')).toBeNull();
    expect(smtpUrlProblem('smtp://mail.carpals.ir:587', 'prod')).toMatch(/login/);
    expect(smtpUrlProblem('smtps://u:p@127.0.0.1:465', 'prod')).toMatch(/this machine/);
    expect(smtpUrlProblem('http://mail.carpals.ir', 'dev')).toMatch(/smtps/);
    expect(smtpUrlProblem('smtp://127.0.0.1:1025', 'dev')).toBeNull();
  });
});
