import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { loopHealth } from "../observability/loop-health.js";
import { logger } from "../observability/logger.js";
import { safeError } from "../observability/safe-error.js";

/**
 * The shape every background loop in this app shares: one tick on boot, then a timer; a tick never
 * overlaps itself; a failing tick is logged and the loop survives; a successful tick beats so
 * `/ready` can see the loop is alive. Six services each had their own copy of this, and two of
 * them differed in ways nobody intended (one swallowed boot errors, one did not report liveness).
 */
export abstract class PeriodicService implements OnApplicationBootstrap, OnApplicationShutdown {
  protected abstract readonly loopName: string;
  protected abstract readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  protected abstract runTick(): Promise<void>;

  async onApplicationBootstrap(): Promise<void> {
    loopHealth.register(this.loopName, this.intervalMs);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one tick now, skipping if the previous one is still running. Returns whether it ran. */
  async tick(): Promise<boolean> {
    // Registration is idempotent; doing it here as well means a tick triggered outside the
    // bootstrap path (a test, a manual reconcile) still reports liveness instead of throwing.
    loopHealth.register(this.loopName, this.intervalMs);
    if (this.running) return false;
    this.running = true;
    try {
      await this.runTick();
      loopHealth.beat(this.loopName);
      return true;
    } catch (error) {
      logger.error(`${this.loopName} tick failed`, { error: safeError(error) });
      return false;
    } finally {
      this.running = false;
    }
  }
}
