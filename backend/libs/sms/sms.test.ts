// SmsGateway port (backend S26a.T3): the contract every provider keeps, run against the mock (and later against each
// vendor adapter with recorded answers), plus the shared helpers.
import { describe, expect, it } from 'vitest';
import { GatewaySmsSender, SendError } from '#libs/infra/index.js';
import {
  assertE164,
  createSmsGateway,
  isOptOut,
  MOCK_BALANCE,
  MockSmsGateway,
  smsSegments,
  SmsSendError,
  type SmsGateway,
} from './index.js';

const OK = '+989121234567';

function contract(name: string, make: (now: () => number) => SmsGateway) {
  describe(`SmsGateway contract: ${name}`, () => {
    it('sendText returns an id, a status and the billed segments; status follows the provider', async () => {
      let t = 1_800_000_000_000;
      const g = make(() => t);
      const r = await g.sendText(OK, 'Your appointment is confirmed', { category: 'notification' });
      expect(r.provider_message_id).toMatch(/^[\w-]{4,200}$/);
      expect(['queued', 'sent']).toContain(r.status);
      expect(r.segments).toBe(1);
      expect(['queued', 'sent', 'unknown']).toContain(await g.status(r.provider_message_id));
      t += 60_000;
      expect(['delivered', 'unknown']).toContain(await g.status(r.provider_message_id));
      expect(await g.status('not-an-id')).toBe('unknown');
    });

    it('sendOtp sends the code (template or fallback text) and the same idempotency key never sends twice', async () => {
      const g = make(Date.now);
      const a = await g.sendOtp(OK, '123456', { templateKey: null, locale: 'fa', fallbackText: 'کد ورود: 123456', idempotencyKey: 'k1' });
      const b = await g.sendOtp(OK, '123456', { templateKey: null, locale: 'fa', fallbackText: 'کد ورود: 123456', idempotencyKey: 'k1' });
      expect(b.provider_message_id).toBe(a.provider_message_id);
    });

    it('refuses a number that is not E.164 or outside the region, permanently', async () => {
      const g = make(Date.now);
      await expect(g.sendText('09121234567', 'x', { category: 'notification' })).rejects.toMatchObject({ permanent: true });
      await expect(g.sendText('+14155550100', 'x', { category: 'notification' })).rejects.toMatchObject({ permanent: true });
    });

    it('reports a balance or null', async () => {
      const b = await make(Date.now).balance();
      expect(b === null || typeof b === 'number').toBe(true);
    });
  });
}

contract('mock', (now) => new MockSmsGateway({ dataDir: null, restrictFile: false, deliveryMs: 5_000, countryCodes: ['+98'], now }));

describe('mock provider', () => {
  it('fails on purpose: permanent numbers always, temporary numbers every other attempt; undeliverable ones fail later', async () => {
    let t = 1_800_000_000_000;
    const g = new MockSmsGateway({
      dataDir: null,
      restrictFile: false,
      deliveryMs: 1_000,
      failPermanent: ['+989000000001'],
      failTemporary: ['+989000000002'],
      undeliverable: ['+989000000003'],
      now: () => t,
    });
    await expect(g.sendText('+989000000001', 'x', { category: 'notification' })).rejects.toMatchObject({ permanent: true });
    await expect(g.sendText('+989000000002', 'x', { category: 'notification' })).rejects.toMatchObject({ permanent: false });
    await expect(g.sendText('+989000000002', 'x', { category: 'notification' })).resolves.toMatchObject({ status: 'queued' });
    const u = await g.sendText('+989000000003', 'x', { category: 'notification' });
    expect(await g.status(u.provider_message_id)).toBe('sent');
    t += 1_000;
    expect(await g.status(u.provider_message_id)).toBe('failed');
    expect(await g.balance()).toBe(MOCK_BALANCE);
    expect(g.simulated).toBe(true);
    expect(g.sent.map((s) => s.to)).toEqual(['+989000000002', '+989000000003']);
  });

  it('is the registry default and records the OTP text', async () => {
    const g = createSmsGateway(
      { env: 'dev', sms: { provider: 'mock', mock: { deliveryMs: 0, failPermanent: [], failTemporary: [] } } },
      { dataDir: null },
    ) as MockSmsGateway;
    expect(g.provider).toBe('mock');
    await g.sendOtp(OK, '654321', { templateKey: 'verify', locale: 'en', fallbackText: 'Your code is 654321' });
    expect(g.sent.at(-1)).toMatchObject({ to: OK, text: 'Your code is 654321', category: 'otp', otp_template: 'verify' });
  });
});

describe('GatewaySmsSender (the SmsSender port over the gateway)', () => {
  it('sends codes through sendOtp, other texts through sendText, and maps failures to SendError', async () => {
    const g = new MockSmsGateway({ dataDir: null, restrictFile: false, deliveryMs: 0, failPermanent: ['+989000000009'] });
    const sender = new GatewaySmsSender(g, 'otp-template');
    const r = await sender.send({
      to: OK,
      template: 'identity.otp_code',
      locale: 'en',
      variables: { code: '111222' },
      text: 'Code 111222',
    });
    expect(r.providerMessageId).toMatch(/^mock-/);
    expect(g.sent.at(-1)).toMatchObject({ category: 'otp', otp_template: 'otp-template' });
    await sender.send({ to: OK, template: 'appointment.reminder', locale: 'en', variables: {}, text: 'Tomorrow 10:00' });
    expect(g.sent.at(-1)).toMatchObject({ category: 'notification', text: 'Tomorrow 10:00' });
    expect(sender.sent).toHaveLength(2);
    expect(sender.provider).toBe('mock');
    const err = await sender.send({ to: '+989000000009', template: 'x', locale: 'en', variables: {}, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).permanent).toBe(true);
  });
});

describe('shared helpers', () => {
  it('counts GSM-7 and UCS-2 (Persian) segments', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'gsm7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ encoding: 'gsm7', segments: 2 });
    expect(smsSegments('a'.repeat(306))).toMatchObject({ segments: 2 });
    expect(smsSegments('a'.repeat(307))).toMatchObject({ segments: 3 });
    expect(smsSegments('{'.repeat(80))).toMatchObject({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(smsSegments('س'.repeat(70))).toMatchObject({ encoding: 'ucs2', segments: 1 });
    expect(smsSegments('س'.repeat(71))).toMatchObject({ encoding: 'ucs2', segments: 2 });
    expect(smsSegments('س'.repeat(134))).toMatchObject({ segments: 2 });
    expect(smsSegments('س'.repeat(135))).toMatchObject({ segments: 3 });
    expect(smsSegments('')).toMatchObject({ segments: 1 });
  });

  it('checks E.164 and the region codes', () => {
    expect(() => assertE164(OK, ['+98'])).not.toThrow();
    expect(() => assertE164(OK)).not.toThrow();
    expect(() => assertE164('+98', ['+98'])).toThrow(SmsSendError);
    expect(() => assertE164('+4915112345678', ['+98'])).toThrow(/country/);
  });

  it('recognises opt-out replies', () => {
    expect(isOptOut(' STOP ')).toBe(true);
    expect(isOptOut('لغو')).toBe(true);
    expect(isOptOut('لغو ۱۱')).toBe(true);
    expect(isOptOut('hello')).toBe(false);
  });
});
