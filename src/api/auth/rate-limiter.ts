import { Injectable } from "@nestjs/common";

/**
 * Two in-memory sliding-window limiters, and the order they run in is the security property.
 *
 * `InitDataGuard` calls them as: IP limiter → HMAC → `AccessService.resolveActiveUser` → per-user
 * limiter. The first one is the only thing in front of an unauthenticated stranger, so it has to be
 * cheap and it has to come before anything that touches PostgreSQL. The per-user limiter comes last
 * because it needs an identity, and by then the request has already proved it has one.
 *
 * The IP key is only meaningful because `main.ts` sets `trust proxy` to the one compose hop. Left at
 * the default every request would carry Caddy's container address, which is worse than no limiter:
 * a stranger could fill the single bucket and lock out the only legitimate user.
 *
 * In memory, so it resets on restart. That is deliberate at this size — the expensive resource, AI
 * spend, is already bounded in the database, and this exists to stop a flood, not to meter usage.
 * The process is single-instance by design (`SingleInstanceService`), so there is no second copy of
 * these counters to disagree with.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the oldest hit in the window falls out of it. Zero when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** Hits permitted per window. */
  limit: number;
  windowMs: number;
  /**
   * How many distinct keys are tracked. Reached only under a distributed flood; the least recently
   * seen keys are dropped, which costs an attacker nothing and costs the process no memory.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 4_096;

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Records a hit and says whether it is permitted. A refused hit is not recorded. */
  consume(key: string, now: number = Date.now()): RateLimitDecision {
    const since = now - this.windowMs;
    const previous = this.hits.get(key);
    const window = previous ? previous.filter((at) => at > since) : [];

    if (window.length >= this.limit) {
      // Refusing does not extend the window: a client that keeps hammering still recovers on time.
      this.hits.set(key, window);
      this.touch(key);
      const oldest = window[0] ?? now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1_000)) };
    }

    window.push(now);
    this.hits.set(key, window);
    this.touch(key);
    this.evict(since);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Test seam; nothing in production clears these counters except a restart. */
  reset(): void {
    this.hits.clear();
  }

  /** Re-inserting moves the key to the end of the Map's insertion order, making eviction LRU. */
  private touch(key: string): void {
    const window = this.hits.get(key);
    if (!window) return;
    this.hits.delete(key);
    this.hits.set(key, window);
  }

  private evict(since: number): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const [key, window] of this.hits) {
      if (this.hits.size <= this.maxKeys) break;
      if (window.length === 0 || (window[window.length - 1] ?? 0) <= since) this.hits.delete(key);
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/**
 * Roughly two requests a second from one address. A screen change costs a handful of calls, so this
 * is far above any real client and far below what it takes to make the process work for a stranger.
 */
export const IP_RATE_LIMIT: RateLimitOptions = { limit: 120, windowMs: 60_000 };

/** Higher, because it applies to a user who has already proved they are on the allowlist. */
export const USER_RATE_LIMIT: RateLimitOptions = { limit: 240, windowMs: 60_000 };

/** Keyed on `req.ip`. Runs before the HMAC, so unsigned input never reaches PostgreSQL. */
@Injectable()
export class ApiIpRateLimiter extends SlidingWindowRateLimiter {
  constructor() {
    super(IP_RATE_LIMIT);
  }
}

/** Keyed on the internal user uuid, never the Telegram id. Runs after `resolveActiveUser`. */
@Injectable()
export class ApiUserRateLimiter extends SlidingWindowRateLimiter {
  constructor() {
    super(USER_RATE_LIMIT);
  }
}
