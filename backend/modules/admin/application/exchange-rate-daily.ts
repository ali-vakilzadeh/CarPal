// Daily exchange rate (backend S26a.T4; owner decision 2026-11-16: the IRR rate is volatile and an administrator sets
// it every morning).
//   - Region day: "today" is the calendar day in the region's time zone (Asia/Tehran for the pilot).
//   - Default at start: a missing display-currency row is created from CARPAL_DEFAULT_IRR_PER_USD (audited as system),
//     so config.client always serves a rate; a rate an administrator set is never overwritten.
//   - Morning reminder (admin.exchange_rate_reminder): from the reminder hour (region time), once per day, while the
//     rate was not set that day, exchange_rate.reminder_due tells the active administrators (staff notice, in the
//     console and by email). The day's exchange_rate.reminder_due event in the outbox keeps it to one per day across
//     restarts; nothing is written to the rate row (its updated_at and version belong to the rate itself).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { ExchangeRates, RegionConfigService } from '#libs/region-config/index.js';
import { InjectConfig, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { DEFAULT_WORK_TIME_ZONE } from './work-sla.js';

/** The pilot region's time zone (the region config has none yet; the work SLAs use the same). */
export const RATE_TIME_ZONE = DEFAULT_WORK_TIME_ZONE;

/** YYYY-MM-DD and the hour of `at` on the region's clock. */
export function regionClock(at: Date, timeZone = RATE_TIME_ZONE): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** ExchangeRate.set_today and age_hours (40 §23.1, 1.5.0). */
export function rateFreshness(updatedAt: Date, now = new Date(), timeZone = RATE_TIME_ZONE): { set_today: boolean; age_hours: number } {
  return {
    set_today: regionClock(updatedAt, timeZone).day === regionClock(now, timeZone).day,
    age_hours: Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 3_600_000)),
  };
}

/** The configured defaults per display currency (IRR only today: CARPAL_DEFAULT_IRR_PER_USD). */
export const configuredDefaults = (config: CarpalConfig): Record<string, string> => ({ IRR: config.rates.defaultIrrPerUsd });

/** Creates the missing display-currency rates from the defaults. Returns the currencies created. */
export async function ensureDefaultRates(
  tx: TxRunner,
  defaults: Readonly<Record<string, string>>,
  displayCurrencies: readonly string[],
): Promise<string[]> {
  const wanted = displayCurrencies.filter((c) => defaults[c]);
  if (wanted.length === 0) return [];
  return tx.run({ actorType: 'system' }, async (scope) => {
    const have = await scope.db.selectFrom('admin.exchange_rates').select('currency').where('currency', 'in', wanted).execute();
    const created: string[] = [];
    for (const currency of wanted) {
      if (have.some((h) => h.currency === currency)) continue;
      const row = await scope.db
        .insertInto('admin.exchange_rates')
        .values({ currency, per_usd: defaults[currency]!, reason: 'default from configuration' })
        .onConflict((oc) => oc.column('currency').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) continue;
      await writeAudit(scope, {
        action: 'admin.exchange_rate_defaulted',
        entityType: 'exchange_rate',
        entityId: row.id,
        reason: 'default from configuration (CARPAL_DEFAULT_<currency>_PER_USD)',
        next: JSON.stringify({ currency, per_usd: defaults[currency] }),
      });
      created.push(currency);
    }
    return created;
  });
}

@Injectable()
export class ExchangeRateReminderRule extends ScheduledRule {
  readonly name = 'admin.exchange_rate_reminder';
  readonly everyMs = 10 * 60_000;
  #defaultsChecked = false;

  constructor(
    private readonly tx: TxRunner,
    private readonly region: RegionConfigService,
    private readonly rates: ExchangeRates,
    @InjectConfig() private readonly config: CarpalConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  /** Returns the number of reminders published (0 or one per stale display currency). */
  async run(now = new Date()): Promise<number> {
    if (!this.#defaultsChecked) {
      const created = await ensureDefaultRates(this.tx, configuredDefaults(this.config), this.#displayCurrencies());
      if (created.length) {
        this.rates.invalidate();
        this.logger.warn({ currencies: created }, 'exchange rate missing: created from the configured default; set the real rate today');
      }
      this.#defaultsChecked = true;
    }
    const clock = regionClock(now);
    if (clock.hour < this.config.rates.reminderHour) return 0;
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const rows = await scope.db
        .selectFrom('admin.exchange_rates')
        .select(['id', 'currency', 'per_usd', 'updated_at'])
        .where('currency', 'in', this.#displayCurrencies())
        .where('deleted_at', 'is', null)
        .forUpdate()
        .execute();
      let sent = 0;
      for (const r of rows) {
        if (rateFreshness(r.updated_at, now).set_today) continue;
        // The row lock above serializes two scheduler instances; the outbox says whether today's reminder went out.
        const already = await scope.db
          .selectFrom('core.domain_event_outbox')
          .select('event_id')
          .where('event_type', '=', 'exchange_rate.reminder_due')
          .where('aggregate_id', '=', r.id)
          .where(sql<boolean>`payload->>'day' = ${clock.day}`)
          .executeTakeFirst();
        if (already) continue;
        await publishEvent(scope, {
          type: 'exchange_rate.reminder_due',
          aggregateType: 'exchange_rate',
          aggregateId: r.id,
          payload: { currency: r.currency, per_usd: String(r.per_usd), day: clock.day },
        });
        sent++;
      }
      return sent;
    });
  }

  #displayCurrencies(): string[] {
    return this.region.forLocale(this.region.locales[0]!).display_currencies.filter((c) => c !== this.region.baseCurrency);
  }
}
