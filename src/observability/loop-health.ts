/**
 * Liveness of the periodic loops (reminder reconciliation, maintenance, occurrence lifecycle...).
 * Each loop registers its interval once and beats after every successful tick; `/ready` reports
 * a loop as stale when three intervals passed without a beat. A loop that has never ticked is
 * given the same grace from the moment it registered, so a booting process is not red.
 */
export type LoopStatus = { name: string; lastTickAt: string | null; intervalMs: number; stale: boolean };

const STALE_INTERVALS = 3;

export class LoopHealth {
  private readonly loops = new Map<string, { intervalMs: number; registeredAt: number; lastTickAt: number | null }>();

  register(name: string, intervalMs: number, now = Date.now()): void {
    if (this.loops.has(name)) return;
    this.loops.set(name, { intervalMs, registeredAt: now, lastTickAt: null });
  }

  beat(name: string, now = Date.now()): void {
    const loop = this.loops.get(name);
    if (!loop) throw new Error(`loop ${name} is not registered`);
    loop.lastTickAt = now;
  }

  snapshot(now = Date.now()): LoopStatus[] {
    return [...this.loops.entries()].map(([name, loop]) => {
      const reference = loop.lastTickAt ?? loop.registeredAt;
      return {
        name,
        lastTickAt: loop.lastTickAt === null ? null : new Date(loop.lastTickAt).toISOString(),
        intervalMs: loop.intervalMs,
        stale: now - reference > loop.intervalMs * STALE_INTERVALS,
      };
    });
  }

  staleLoops(now = Date.now()): string[] {
    return this.snapshot(now)
      .filter((loop) => loop.stale)
      .map((loop) => loop.name);
  }

  /** Test seam. */
  reset(): void {
    this.loops.clear();
  }
}

export const loopHealth = new LoopHealth();
