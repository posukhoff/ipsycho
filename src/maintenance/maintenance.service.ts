import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { AccessService } from "../access/access.service.js";
import { ActionsService } from "../actions/actions.service.js";
import { AiService } from "../ai/ai.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { users, userSettings } from "../database/schema.js";
import { eq } from "drizzle-orm";
import { SettingsService } from "../settings/settings.service.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { ContextService } from "../context/context.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { TasksRepository } from "../tasks/tasks.repository.js";
import { RESULT_CHECK_IGNORE_GRACE_MINUTES } from "../core/result-check.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import { safeError } from "../observability/safe-error.js";

const TICK_MS = 60 * 60_000;
const RAW_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60_000;

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly actions: ActionsService,
    private readonly ai: AiService,
    private readonly messages: MessagesRepository,
    private readonly context: ContextService,
    private readonly tasks: TasksRepository,
    private readonly reminders: ReminderSchedulingService,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
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
      const cutoff = new Date(now.getTime() - RAW_MESSAGE_RETENTION_MS);
      const ignoredCheckCutoff = new Date(now.getTime() - RESULT_CHECK_IGNORE_GRACE_MINUTES * 60_000);
      const [messagesDeleted, confirmationsExpired, auditPayloadsCleared, eventDetailsCleared, accountsDeleted, ignoredResultChecks, fuzzyReviewsRebuilt] = await Promise.all([
        this.messages.deleteRawOlderThan(cutoff),
        this.actions.cleanupExpiredConfirmations(now),
        this.actions.cleanupExpiredAuditPayloads(now),
        this.tasks.clearEventDetailsOlderThan(cutoff),
        this.access.finalizeExpiredDeletions(now),
        this.tasks.markIgnoredResultChecks(ignoredCheckCutoff, now),
        this.reminders.reconcileFuzzyReviews(now),
      ]);
      // Topic rows may still be referenced by slightly newer assistant messages. Retention
      // therefore scrubs content instead of deleting the topic metadata/foreign-key target.
      const topicSummariesCleared = await this.context.scrubExpiredTopicSummaries(now);
      await this.checkAiSpendWarnings(now);
      if (messagesDeleted || topicSummariesCleared || confirmationsExpired || auditPayloadsCleared || eventDetailsCleared || accountsDeleted || ignoredResultChecks || fuzzyReviewsRebuilt) {
        console.log("maintenance completed", {
          messagesDeleted, topicSummariesCleared, confirmationsExpired, auditPayloadsCleared, eventDetailsCleared, accountsDeleted,
          ignoredResultChecks, fuzzyReviewsRebuilt,
        });
      }
    } catch (error) {
      console.error("maintenance failed", safeError(error));
    } finally {
      this.running = false;
    }
  }
  private async checkAiSpendWarnings(now: Date): Promise<void> {
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rows = await this.database.db.select({ user: users, settings: userSettings }).from(users)
      .innerJoin(userSettings, eq(userSettings.userId, users.id))
      .where(eq(users.status, "active"));
    for (const row of rows) {
      if (row.settings.lastAiSpendWarningMonth === month) continue;
      const threshold = Number(row.settings.aiMonthlyWarningUsd);
      if (!Number.isFinite(threshold) || threshold <= 0) continue;
      const spend = await this.ai.monthlySpendUsd(row.user.id, monthStart);
      if (spend < threshold) continue;
      const marked = await this.settings.markSpendWarning(row.user.id, month);
      if (!marked) continue;
      const amount = spend.toFixed(2);
      await this.telegram.sendMessage(row.user.telegramUserId, `Предупреждение: оценочные расходы AI в этом месяце достигли $${amount}. Это только уведомление; AI автоматически не отключается.`).catch(() => undefined);
      if (this.config.ownerTelegramUserId && this.config.ownerTelegramUserId !== row.user.telegramUserId) {
        await this.telegram.sendMessage(this.config.ownerTelegramUserId, `IPsycho: пользователь ${row.user.id} достиг AI spend warning $${amount}.`).catch(() => undefined);
      }
    }
  }

}
