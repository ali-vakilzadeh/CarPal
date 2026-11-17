// Consent-text seed validation (backend S26a.T5): the owner's reviewed file is checked before anything is written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConsentTexts, parseSeedArgs } from './consent-texts.js';
import { repoDir } from './config.js';

const template = () =>
  JSON.parse(readFileSync(join(repoDir, 'database', 'seeds', 'consent-texts.template.json'), 'utf8')) as {
    meta: { status: string };
    items: { consent_type: string; body: { en: string; fa: string }; title: { en: string; fa: string } }[];
  };

/** The template made "reviewed": approved and without placeholders. */
function approved() {
  const t = template();
  t.meta.status = 'approved';
  // Placeholders can nest ("[… [country] …]"): strip the brackets until none is left.
  const strip = (x: string): string => {
    let prev = '';
    while (prev !== x) {
      prev = x;
      x = x.replace(/\[([^[\]\n]{1,200})\](?!\()/g, '$1');
    }
    return x;
  };
  for (const i of t.items)
    for (const f of [i.title, i.body]) {
      f.en = strip(f.en);
      f.fa = strip(f.fa);
    }
  return t;
}

describe('parseConsentTexts', () => {
  it('accepts the reviewed file: 13 consent types, EN and FA', () => {
    expect(parseConsentTexts(approved(), { env: 'prod', allowPlaceholders: false })).toHaveLength(13);
  });

  it('accepts the template itself only with --allow-placeholders in dev', () => {
    expect(parseConsentTexts(template(), { env: 'dev', allowPlaceholders: true })).toHaveLength(13);
    expect(() => parseConsentTexts(template(), { env: 'dev', allowPlaceholders: false })).toThrow(/approved|placeholder/);
    expect(() => parseConsentTexts(template(), { env: 'staging', allowPlaceholders: true })).toThrow(/dev only/);
  });

  it('refuses HTML, a missing type and a type listed twice', () => {
    const html = approved();
    html.items[0]!.body.en += '\n<script>alert(1)</script>';
    expect(() => parseConsentTexts(html, { env: 'prod', allowPlaceholders: false })).toThrow(/HTML/);
    const missing = approved();
    missing.items.pop();
    expect(() => parseConsentTexts(missing, { env: 'prod', allowPlaceholders: false })).toThrow(/marketing: missing/);
    const twice = approved();
    twice.items[1] = twice.items[0]!;
    expect(() => parseConsentTexts(twice, { env: 'prod', allowPlaceholders: false })).toThrow(/listed twice/);
  });

  it('keeps Markdown links and refuses a field it does not know', () => {
    const t = approved();
    t.items[0]!.body.en += '\n\nRead the [Privacy Policy](https://carpals.ir/privacy).';
    expect(parseConsentTexts(t, { env: 'prod', allowPlaceholders: false })).toHaveLength(13);
    (t.items[0] as Record<string, unknown>).extra = 1;
    expect(() => parseConsentTexts(t, { env: 'prod', allowPlaceholders: false })).toThrow(/Invalid consent-text file/);
  });
});

describe('parseSeedArgs', () => {
  it('reads --file, --region and --allow-placeholders', () => {
    expect(parseSeedArgs(['--file', 'x.json'])).toEqual({ file: 'x.json', region: null, allowPlaceholders: false });
    expect(parseSeedArgs(['--file', 'x.json', '--region', 'ir-pilot', '--allow-placeholders'])).toEqual({
      file: 'x.json',
      region: 'ir-pilot',
      allowPlaceholders: true,
    });
    expect(() => parseSeedArgs([])).toThrow(/Usage/);
    expect(() => parseSeedArgs(['--file', 'x', '--region', 'BAD REGION'])).toThrow(/Usage/);
  });
});
