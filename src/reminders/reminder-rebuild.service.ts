import { Inject, Injectable } from "@nestjs/common";
import { PeriodicService } from "../runtime/periodic.service.js";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { taskOccurrences } from "../database/schema.js";
import { ReminderSchedulingService } from "./reminder-scheduling.service.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";

const TICK_MS = 60_000;

@Injectable()
export class ReminderRebuildService extends PeriodicService {
  protected readonly loopName = "reminder_rebuild";
  protected readonly intervalMs = TICK_MS;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ReminderSchedulingService) private readonly scheduling: ReminderSchedulingService,
  ) {
    super();
  }

  protected async runTick(): Promise<void> {
    const rows = await this.database.db
      .select({ workspaceId: taskOccurrences.workspaceId, id: taskOccurrences.id })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.needsReminderRebuild, true))
      .limit(100);
    for (const row of rows) {
      try {
        await this.scheduling.rebuildOccurrence(row.workspaceId, row.id);
      } catch (error) {
        logger.error("reminder rebuild failed", { occurrenceId: row.id, error: safeError(error) });
      }
    }
  }
}
