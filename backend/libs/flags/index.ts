// L14 feature flags (41 §2.2; 52 FeatureFlag; 40 §0.4 FLAG, SEC-AI-6): flags of
// the current environment are read from admin.feature_flags and cached in
// process for one refresh interval. ai.automation.kill_switch turns every
// ai_feature flag off. FLAG(key) off → 403 FEATURE_DISABLED, or 503
// AI_UNAVAILABLE (with a retry delay) for AI flags. Unknown keys are off.
import { createHash } from 'node:crypto';
import { ApiError } from '#libs/contract/index.js';
import type { TxRunner } from '#libs/tenancy/index.js';

export const KILL_SWITCH = 'ai.automation.kill_switch';
const AI_RETRY_MS = 60_000;

export type FlagType = 'release' | 'beta' | 'ai_feature' | 'kill_switch';

/** 52 FeatureFlag.targeting: every present criterion must match. */
export interface Targeting {
  roles?: string[];
  regions?: string[];
  organization_ids?: string[];
  plan_keys?: string[];
  percentage?: number;
}

export interface FlagRecord {
  key: string;
  type: FlagType;
  enabled: boolean;
  targeting: Targeting | null;
}

/** Caller attributes for targeting. */
export interface FlagContext {
  userId?: string;
  anonKey?: string;
  orgId?: string;
  roles?: string[];
  region?: string;
  planKey?: string;
}

export interface FlagLogger {
  warn(obj: object, msg: string): void;
}

export class FlagService {
  #cache: { at: number; flags: Map<string, FlagRecord> } | null = null;
  #loading: Promise<Map<string, FlagRecord>> | null = null;

  constructor(
    private readonly tx: TxRunner,
    private readonly env: 'dev' | 'staging' | 'prod',
    private readonly refreshMs: number,
    private readonly log?: FlagLogger,
  ) {}

  async #flags(): Promise<Map<string, FlagRecord>> {
    if (this.#cache && Date.now() - this.#cache.at < this.refreshMs) return this.#cache.flags;
    this.#loading ??= this.tx
      .run({ actorType: 'anonymous' }, ({ db }) =>
        db
          .selectFrom('admin.feature_flags')
          .select(['key', 'flag_type', 'enabled', 'targeting'])
          .where('environment', '=', this.env)
          .where('deleted_at', 'is', null)
          .execute(),
      )
      .then((rows) => {
        const flags = new Map(
          rows.map((r) => [
            r.key,
            { key: r.key, type: r.flag_type as FlagType, enabled: r.enabled, targeting: (r.targeting as Targeting | null) ?? null },
          ]),
        );
        this.#cache = { at: Date.now(), flags };
        return flags;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  /** Drops the cache (admin.flag_update calls it; other processes refresh within refreshMs). */
  invalidate(): void {
    this.#cache = null;
  }

  async isEnabled(key: string, ctx: FlagContext = {}): Promise<boolean> {
    const flags = await this.#flags();
    const flag = flags.get(key);
    if (!flag) {
      this.log?.warn({ flag: key }, 'unknown feature flag treated as off');
      return false;
    }
    return evaluate(flag, flags, ctx);
  }

  async type(key: string): Promise<FlagType | undefined> {
    return (await this.#flags()).get(key)?.type;
  }

  /** FLAG(key) guard. */
  async require(key: string, ctx: FlagContext = {}): Promise<void> {
    if (await this.isEnabled(key, ctx)) return;
    const type = await this.type(key);
    if (type === 'ai_feature' || key.startsWith('ai.'))
      throw new ApiError('AI_UNAVAILABLE', { retryAfterMs: AI_RETRY_MS, detail: `flag ${key} off` });
    throw new ApiError('FEATURE_DISABLED', { detail: `flag ${key} off` });
  }

  /** Every flag evaluated for the caller, without targeting rules (config.client). */
  async evaluateAll(ctx: FlagContext = {}): Promise<{ key: string; enabled: boolean }[]> {
    const flags = await this.#flags();
    return [...flags.values()].sort((a, b) => a.key.localeCompare(b.key)).map((f) => ({ key: f.key, enabled: evaluate(f, flags, ctx) }));
  }
}

function evaluate(flag: FlagRecord, all: Map<string, FlagRecord>, ctx: FlagContext): boolean {
  if (!flag.enabled) return false;
  if (flag.type === 'ai_feature' && all.get(KILL_SWITCH)?.enabled) return false;
  const t = flag.targeting;
  if (!t) return true;
  if (t.roles?.length && !t.roles.some((r) => ctx.roles?.includes(r))) return false;
  if (t.regions?.length && !(ctx.region && t.regions.includes(ctx.region))) return false;
  if (t.organization_ids?.length && !(ctx.orgId && t.organization_ids.includes(ctx.orgId))) return false;
  if (t.plan_keys?.length && !(ctx.planKey && t.plan_keys.includes(ctx.planKey))) return false;
  if (typeof t.percentage === 'number') {
    const subject = ctx.userId ?? ctx.anonKey;
    if (!subject) return t.percentage >= 100;
    const bucket = createHash('sha256').update(`${flag.key}:${subject}`).digest().readUInt32BE(0) % 100;
    if (bucket >= t.percentage) return false;
  }
  return true;
}
