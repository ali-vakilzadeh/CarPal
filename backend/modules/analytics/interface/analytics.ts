// Public interface of the analytics module (41 §2.1 M14; 52 §18). Other
// modules contribute daily gauges for the staff dashboards (counts only, no
// personal data) without the analytics module reading their tables.
import type { TxScope } from '#libs/tenancy/index.js';

/** A count at the time of the daily aggregation (system context, primary database). */
export type MetricGauge = (scope: TxScope) => Promise<number>;

export class MetricGauges {
  readonly #gauges = new Map<string, MetricGauge>();

  register(key: string, gauge: MetricGauge): void {
    if (!/^gauge\.[a-z0-9_.]{1,60}$/.test(key)) throw new Error(`invalid gauge key ${key}`);
    if (this.#gauges.has(key)) throw new Error(`gauge ${key} registered twice`);
    this.#gauges.set(key, gauge);
  }

  entries(): [string, MetricGauge][] {
    return [...this.#gauges.entries()];
  }
}
