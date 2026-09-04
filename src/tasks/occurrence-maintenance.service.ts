import { Injectable } from "@nestjs/common";
import { PeriodicService } from "../runtime/periodic.service.js";
import { evaluateOccurrenceLifecycle } from "../core/lifecycle.js";
import { TasksRepository } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";

const TICK_MS = 60_000;
const EVENT_ELAPSE_GRACE_MINUTES = 15;
const LIFECYCLE_PAGE = 500;

type LifecycleRow = Awaited<ReturnType<TasksRepository["listLifecycleCandidates"]>>[number];

@Injectable()
export class OccurrenceMaintenanceService extends PeriodicService {
  protected readonly loopName = "occurrence_lifecycle";
  protected readonly intervalMs = TICK_MS;

  constructor(
    private readonly repository: TasksRepository,
    private readonly tasks: TasksService,
  ) {
    super();
  }

  protected async runTick(): Promise<void> {
    const now = new Date();
    let afterId: string | null = null;
    for (;;) {
      const rows = await this.repository.listLifecycleCandidates(afterId, LIFECYCLE_PAGE);
      for (const { task, occurrence } of rows) await this.apply(task, occurrence, now);
      const last = rows[rows.length - 1];
      if (rows.length < LIFECYCLE_PAGE || !last) break;
      afterId = last.occurrence.id;
    }
  }

  private evaluate(task: LifecycleRow["task"], occurrence: LifecycleRow["occurrence"], now: Date) {
    return evaluateOccurrenceLifecycle({
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
  }

  private async apply(task: LifecycleRow["task"], occurrence: LifecycleRow["occurrence"], now: Date): Promise<void> {
    const decision = this.evaluate(task, occurrence, now);
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
        await this.repository.markOccurrenceOverdue({ workspaceId: occurrence.workspaceId, occurrenceId: occurrence.id, expectedVersion: occurrence.version });
      }
    } catch (error) {
      // Optimistic concurrency means a user action may win between scan and update.
      logger.warn("occurrence maintenance skipped stale row", { occurrenceId: occurrence.id, error: safeError(error) });
    }
  }
}
