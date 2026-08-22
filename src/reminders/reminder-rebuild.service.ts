import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { taskOccurrences } from "../database/schema.js";
import { ReminderSchedulingService } from "./reminder-scheduling.service.js";
import { safeError } from "../observability/safe-error.js";

const TICK_MS = 60_000;

@Injectable()
export class ReminderRebuildService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ReminderSchedulingService) private readonly scheduling: ReminderSchedulingService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((error) => console.error("reminder rebuild tick failed", safeError(error))), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.database.db.select({ workspaceId: taskOccurrences.workspaceId, id: taskOccurrences.id })
        .from(taskOccurrences).where(eq(taskOccurrences.needsReminderRebuild, true)).limit(100);
      for (const row of rows) {
        try {
          await this.scheduling.rebuildOccurrence(row.workspaceId, row.id);
        } catch (error) {
          console.error("reminder rebuild failed", { occurrenceId: row.id, error: safeError(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
