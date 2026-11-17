// pnpm mail:test --to <address>   (backend S26a.T2; deploy.md "Email")
// Checks the SMTP settings of this environment from the machine it runs on: connects to the CARPAL_SMTP_URL host,
// starts TLS, logs in with the mailbox and sends one plain test message. Never prints the password. On a server run it
// with the deployment's settings: sudo bash deploy/mail-test.sh you@example.com (deploy.md "Email").
import { loadConfig } from '#libs/config/index.js';
import { MemoryKeyValueStore, SmtpMailer } from '#libs/infra/index.js';

function args(argv: readonly string[]): { to: string } {
  const i = argv.indexOf('--to');
  const to = i >= 0 ? argv[i + 1] : undefined;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Usage: pnpm mail:test --to <address>');
  return { to };
}

async function main(): Promise<void> {
  const { to } = args(process.argv.slice(2));
  const config = loadConfig();
  const url = new URL(config.services.smtpUrl);
  console.log(
    `SMTP server: ${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'smtps:' ? 465 : 587)} as ${decodeURIComponent(url.username) || '(no login)'}`,
  );
  console.log(`From: ${config.mail.from}   transport setting: ${config.mail.transport}`);
  if (config.mail.transport !== 'smtp')
    console.log('Note: CARPAL_MAIL_TRANSPORT is not smtp, so the backend itself still writes mail to the outbox file.');
  const mailer = new SmtpMailer({
    url: config.services.smtpUrl,
    from: config.mail.from,
    replyTo: config.mail.replyTo,
    maxPerHour: config.mail.maxPerHour,
    env: config.env,
    tlsInsecure: config.mail.tlsInsecure,
    kv: new MemoryKeyValueStore(),
  });
  try {
    await mailer.verify();
    console.log('Connected, TLS and login: ok');
    const receipt = await mailer.send({
      to,
      template: 'system.mail_test',
      locale: 'en',
      variables: {},
      subject: 'CarPal mail test / آزمایش ایمیل کارپال',
      text: `This message checks that the CarPal backend can send mail through ${url.hostname}.\nاین پیام بررسی می‌کند که سرور کارپال می‌تواند ایمیل بفرستد.\n\nSent at ${new Date().toISOString()}.`,
    });
    console.log(`Sent: ${receipt.providerMessageId ?? '(no message id)'}. Check the inbox (and the spam folder) of ${to}.`);
  } finally {
    mailer.close();
  }
}

main().catch((err: unknown) => {
  const e = err as { code?: string; responseCode?: number; message?: string };
  console.error(
    `Mail test failed: ${[e.code, e.responseCode, e.message]
      .filter(Boolean)
      .join(' ')
      .replace(/\/\/[^@\s]*@/g, '//***@')}`,
  );
  process.exit(1);
});
