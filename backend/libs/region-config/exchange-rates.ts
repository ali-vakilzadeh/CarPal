// Exchange rates of the display currencies (52 ExchangeRate, GD-41), cached like feature flags: every client reads them
// through config.client. Display only: stored amounts, ranking and filters never use them.
import type { TxRunner } from '#libs/tenancy/index.js';

/** One row of RegionConfig.exchange_rates. */
export interface ExchangeRateView {
  currency: string;
  per_usd: string;
  updated_at: string;
}

export class ExchangeRates {
  #cache: { at: number; rates: ExchangeRateView[] } | null = null;
  #loading: Promise<ExchangeRateView[]> | null = null;

  constructor(
    private readonly tx: TxRunner,
    private readonly refreshMs: number,
  ) {}

  async all(): Promise<ExchangeRateView[]> {
    if (this.#cache && Date.now() - this.#cache.at < this.refreshMs) return this.#cache.rates;
    this.#loading ??= this.tx
      .run({ actorType: 'anonymous' }, ({ db }) =>
        db
          .selectFrom('admin.exchange_rates')
          .select(['currency', 'per_usd', 'updated_at'])
          .where('deleted_at', 'is', null)
          .orderBy('currency')
          .execute(),
      )
      .then((rows) => {
        const rates = rows.map((r) => ({ currency: r.currency, per_usd: String(r.per_usd), updated_at: r.updated_at.toISOString() }));
        this.#cache = { at: Date.now(), rates };
        return rates;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  /** Drops the cache (admin.exchange_rate_update, and exchange_rate.changed from other processes). */
  invalidate(): void {
    this.#cache = null;
  }
}
