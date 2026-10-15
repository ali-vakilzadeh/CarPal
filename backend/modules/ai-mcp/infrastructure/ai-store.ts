// The AI gateway's own database access (41 §1 D6/D7, §3.3; GD-35): AI output
// (insights, suggestions, approval requests) and MCP registry reads run as
// carpal_ai, which may touch the ai_mcp schema, the outbox, jobs and audit
// only, in the system RLS context. The API and worker roles never insert AI
// output themselves. Lite mode runs this in the API/worker process; the pool
// connects lazily.
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { Database } from '#libs/db/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';

@Injectable()
export class AiStore implements OnApplicationShutdown {
  readonly #db: Database;
  readonly #tx: TxRunner;

  constructor(@InjectConfig() config: CarpalConfig) {
    this.#db = new Database(config, 'carpal_ai', { max: 4, applicationName: 'carpal-ai-gateway' });
    this.#tx = new TxRunner(this.#db);
  }

  run<T>(fn: (scope: TxScope) => Promise<T>, requestId?: string): Promise<T> {
    return this.#tx.run({ actorType: 'system', requestId: requestId ?? null }, fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#db.close();
  }
}
