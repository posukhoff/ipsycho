import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { evaluateOccurrenceLifecycle } from "../core/lifecycle.js";
import { TasksRepository } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";

const TICK_MS = 60_000;
const EVENT_ELAPSE_GRACE_MINUTES = 15;

@Injectable()
export class OccurrenceMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: TasksRepository,
    private readonly tasks: TasksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((error) => logger.error("occurrence maintenance tick failed", { error: safeError(error) })), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const rows = await this.repository.listLifecycleCandidates();
      for (const { task, occurrence } of rows) {
        const decision = evaluateOccurrenceLifecycle({
          kind: task.kind,
          timeMode: task.timeMode,
          recurring: Boolean(task.recurrenceRule),
          ...(task.missPolicy ? { missPolicy: task.missPolicy } : {}),
          status: occurrence.status,
          timezone: occurrence.timezone,
          now,
          ...(occurrence.plannedStartAt ? { plannedStartAt: occurrence.plannedStartAt } : {}),
          ...(occurrence.plannedEndAt ? { plannedEndAt: occurrence.plannedEndAt } : {}),
          ...(occurrence.plannedLocalDate ? { plannedLocalDate: occurrence.plannedLocalDate } : {}),
          ...(occurrence.recurrenceKey ? { recurrenceKey: occurrence.recurrenceKey } : {}),
          ...(occurrence.dueAt ? { dueAt: occurrence.dueAt } : {}),
          ...(occurrence.dueLocalDate ? { dueLocalDate: occurrence.dueLocalDate } : {}),
          ...(occurrence.expiresAt ? { expiresAt: occurrence.expiresAt } : {}),
          overdue: occurrence.overdue,
          eventElapseGraceMinutes: EVENT_ELAPSE_GRACE_MINUTES,
        });

        try {
          if (decision.transitionTo) {
            await this.tasks.setOccurrenceStatus({
              workspaceId: occurrence.workspaceId,
              occurrenceId: occurrence.id,
              expectedVersion: occurrence.version,
              nextStatus: decision.transitionTo,
              now,
              systemExpire: decision.transitionTo === "skipped",
              eventElapseGraceMinutes: EVENT_ELAPSE_GRACE_MINUTES,
            });
          } else if (decision.markOverdue) {
            await this.repository.markOccurrenceOverdue({
              workspaceId: occurrence.workspaceId,
              occurrenceId: occurrence.id,
              expectedVersion: occurrence.version,
            });
          }
        } catch (error) {
          // Optimistic concurrency means a user action may win between scan and update.
          logger.warn("occurrence maintenance skipped stale row", { occurrenceId: occurrence.id, error: safeError(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
