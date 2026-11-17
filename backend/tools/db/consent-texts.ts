// Consent-text seed (backend S26a.T5; owner decision 2026-11-16): loads the reviewed texts of the 13 consent types
// (database/seeds/consent-texts.json, made from consent-texts.template.json) as DRAFT versions of each consent type's
// document in the region. Publishing stays in the admin console (A-POL-01, admin.policy_version_publish, four eyes,
// effective date). A consent type that already has the file's version is reported and left alone; published versions
// are never changed. Runs on the server like staff:bootstrap (deploy/seed-consent-texts.sh), as actor system, audited.
import { z } from 'zod';
import { writeAudit } from '#libs/audit/index.js';
import type { TxRunner } from '#libs/tenancy/index.js';
import { CONSENT_TEXT_KEYS, ensureDocument } from '#modules/identity/application/policy-texts.js';
import type { CarpalEnv } from './config.js';

const L10nText = (max: number) => z.object({ en: z.string().trim().min(1).max(max), fa: z.string().trim().min(1).max(max) }).strict();

const ItemSchema = z
  .object({
    consent_type: z.string(),
    policy_version: z.string().trim().min(1).max(20),
    requires_reconsent: z.boolean(),
    grounded_in: z.string().max(2000).optional(),
    title: L10nText(200),
    body: L10nText(20_000),
    change_summary: L10nText(1000).nullable().optional(),
  })
  .strict();

const FileSchema = z.object({
  meta: z.object({ status: z.string() }).loose(),
  items: z.array(ItemSchema).min(1).max(50),
});

export type ConsentTextItem = z.output<typeof ItemSchema>;

/** A Markdown text must not carry HTML (S15: the clients render Markdown without HTML). */
const HTML = /<\/?[a-z][^>]*>|<!--|&lt;\s*script/i;
/** A placeholder of the template: "[if you add it]", "[company address]" … but not a Markdown link "[text](url)". */
const PLACEHOLDER = /\[[^\]\n]{1,200}\](?!\()/;

export interface ParseOptions {
  env: CarpalEnv;
  /** Dev only: accept [bracketed] placeholders and a status other than approved (testing on the template). */
  allowPlaceholders: boolean;
}

/** Validates the file; throws one error listing every problem. */
export function parseConsentTexts(json: unknown, o: ParseOptions): ConsentTextItem[] {
  if (o.allowPlaceholders && o.env !== 'dev') throw new Error('--allow-placeholders is dev only');
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`Invalid consent-text file:\n${parsed.error.issues.map((i) => `  [${i.path.join('.')}] ${i.message}`).join('\n')}`);
  const problems: string[] = [];
  if (parsed.data.meta.status !== 'approved' && !o.allowPlaceholders)
    problems.push(`meta.status is "${parsed.data.meta.status}": the owner's reviewed file has "approved"`);
  const seen = new Set<string>();
  for (const [n, item] of parsed.data.items.entries()) {
    const at = `items[${n}] ${item.consent_type}`;
    if (!(CONSENT_TEXT_KEYS as readonly string[]).includes(item.consent_type)) problems.push(`${at}: not a consent type`);
    if (seen.has(item.consent_type)) problems.push(`${at}: listed twice`);
    seen.add(item.consent_type);
    const texts: [string, string][] = [
      ['title.en', item.title.en],
      ['title.fa', item.title.fa],
      ['body.en', item.body.en],
      ['body.fa', item.body.fa],
      ...(item.change_summary
        ? ([
            ['change_summary.en', item.change_summary.en],
            ['change_summary.fa', item.change_summary.fa],
          ] as [string, string][])
        : []),
    ];
    for (const [field, text] of texts) {
      if (HTML.test(text)) problems.push(`${at}: ${field} contains HTML (Markdown only)`);
      if (!o.allowPlaceholders && PLACEHOLDER.test(text))
        problems.push(`${at}: ${field} still has a [bracketed] placeholder: ${PLACEHOLDER.exec(text)![0]}`);
    }
  }
  for (const key of CONSENT_TEXT_KEYS) if (!seen.has(key)) problems.push(`${key}: missing (all 13 consent types are needed)`);
  if (problems.length) throw new Error(`Invalid consent-text file:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return parsed.data.items;
}

export interface SeedResult {
  consent_type: string;
  policy_version: string;
  status: 'created' | 'exists';
  /** exists: the status of the version already there (draft, scheduled, published, superseded). */
  existing_status?: string;
}

/** Creates each text as a draft version; never changes an existing version. */
export async function seedConsentTexts(tx: TxRunner, region: string, items: readonly ConsentTextItem[]): Promise<SeedResult[]> {
  return tx.run({ actorType: 'system' }, async (scope) => {
    const out: SeedResult[] = [];
    for (const item of items) {
      const doc = await ensureDocument(scope, region, item.consent_type as (typeof CONSENT_TEXT_KEYS)[number]);
      const existing = await scope.db
        .selectFrom('identity.policy_versions')
        .select(['id', 'status'])
        .where('document_id', '=', doc.id)
        .where('policy_version', '=', item.policy_version)
        .executeTakeFirst();
      if (existing) {
        out.push({
          consent_type: item.consent_type,
          policy_version: item.policy_version,
          status: 'exists',
          existing_status: existing.status,
        });
        continue;
      }
      const v = await scope.db
        .insertInto('identity.policy_versions')
        .values({
          document_id: doc.id,
          policy_version: item.policy_version,
          title_translations: JSON.stringify(item.title),
          body_translations: JSON.stringify(item.body),
          change_summary_translations: item.change_summary ? JSON.stringify(item.change_summary) : null,
          requires_reconsent: item.requires_reconsent,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'policy.version_created',
        entityType: 'policy_version',
        entityId: v.id,
        reason: 'consent-text seed (pnpm seed:consent-texts, backend S26a)',
        next: JSON.stringify({ policy_key: item.consent_type, region_key: region, policy_version: item.policy_version, status: 'draft' }),
      });
      out.push({ consent_type: item.consent_type, policy_version: item.policy_version, status: 'created' });
    }
    return out;
  });
}

export function parseSeedArgs(argv: readonly string[]): { file: string; region: string | null; allowPlaceholders: boolean } {
  const usage =
    'Usage: pnpm seed:consent-texts --file <consent-texts.json> [--region ir-pilot] [--allow-placeholders]   (the last is dev only)';
  let file: string | null = null;
  let region: string | null = null;
  let allowPlaceholders = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--allow-placeholders') allowPlaceholders = true;
    else if (a === '--file' && argv[i + 1]) file = argv[++i]!;
    else if (a === '--region' && argv[i + 1] && /^[a-z0-9-]{2,40}$/.test(argv[i + 1]!)) region = argv[++i]!;
    else throw new Error(usage);
  }
  if (!file) throw new Error(usage);
  return { file, region, allowPlaceholders };
}
