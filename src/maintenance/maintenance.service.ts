import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { AccessService } from "../access/access.service.js";
import { ActionsService } from "../actions/actions.service.js";
import { AiService } from "../ai/ai.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { telegramUpdates, users, userSettings } from "../database/schema.js";
import { and, eq, inArray, lt, ne, or, isNull } from "drizzle-orm";
import { CLEANUP_BATCH, drainInBatches } from "../database/batched.js";
import { interfaceLocale } from "../core/language.js";
import { t } from "../telegram/copy/index.js";
import { SettingsService } from "../settings/settings.service.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { ContextService } from "../context/context.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { TasksRepository } from "../tasks/tasks.repository.js";
import { RESULT_CHECK_IGNORE_GRACE_MINUTES } from "../core/result-check.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import { ReminderQueueService } from "../reminders/reminder-queue.service.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";
import { loopHealth } from "../observability/loop-health.js";

const TICK_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RAW_MESSAGE_RETENTION_MS = 90 * DAY_MS;
/** The task journal feeds counters and recent history only; a year is longer than any reader looks back. */
export const TASK_EVENT_RETENTION_DAYS = 365;
/** Telegram update ids are the idempotency ledger; Telegram itself stops redelivering long before this. */
export const TELEGRAM_UPDATE_RETENTION_DAYS = 7;

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  /** The last queue problem reported to the owner; the same problem is not repeated every hour. */
  private lastAlertSignature = "";

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
    private readonly reminderQueue: ReminderQueueService,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    loopHealth.register("maintenance", TICK_MS);
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
      const [
        messagesDeleted,
        confirmationsExpired,
        auditPayloadsCleared,
        eventDetailsCleared,
        accountsDeleted,
        ignoredResultChecks,
        fuzzyReviewsRebuilt,
        eventsDeleted,
        updatesDeleted,
      ] = await Promise.all([
        this.messages.deleteRawOlderThan(cutoff),
        this.actions.cleanupExpiredConfirmations(now),
        this.actions.cleanupExpiredAuditPayloads(now),
        this.tasks.clearEventDetailsOlderThan(cutoff),
        this.access.finalizeExpiredDeletions(now),
        this.tasks.markIgnoredResultChecks(ignoredCheckCutoff, now),
        this.reminders.reconcileFuzzyReviews(now),
        this.tasks.deleteEventsOlderThan(new Date(now.getTime() - TASK_EVENT_RETENTION_DAYS * DAY_MS)),
        this.deleteTelegramUpdatesOlderThan(new Date(now.getTime() - TELEGRAM_UPDATE_RETENTION_DAYS * DAY_MS)),
      ]);
      // Topic rows may still be referenced by slightly newer assistant messages. Retention
      // therefore scrubs content instead of deleting the topic metadata/foreign-key target.
      const topicSummariesCleared = await this.context.scrubExpiredTopicSummaries(now);
      await this.checkAiSpendWarnings(now);
      await this.alertOwnerOnQueueProblems(now);
      await this.pingDeadManSwitch();
      if (
        messagesDeleted ||
        topicSummariesCleared ||
        confirmationsExpired ||
        auditPayloadsCleared ||
        eventDetailsCleared ||
        accountsDeleted ||
        ignoredResultChecks ||
        fuzzyReviewsRebuilt ||
        eventsDeleted ||
        updatesDeleted
      ) {
        logger.info("maintenance completed", {
          messagesDeleted,
          topicSummariesCleared,
          confirmationsExpired,
          auditPayloadsCleared,
          eventDetailsCleared,
          accountsDeleted,
          ignoredResultChecks,
          fuzzyReviewsRebuilt,
          eventsDeleted,
          updatesDeleted,
        });
      }
      loopHealth.beat("maintenance");
    } catch (error) {
      logger.error("maintenance failed", { error: safeError(error) });
    } finally {
      this.running = false;
    }
  }
  private async deleteTelegramUpdatesOlderThan(cutoff: Date): Promise<number> {
    return drainInBatches(CLEANUP_BATCH, async () => {
      const batch = this.database.db
        .select({ id: telegramUpdates.telegramUpdateId })
        .from(telegramUpdates)
        .where(and(eq(telegramUpdates.botIdentity, this.config.botIdentity), lt(telegramUpdates.createdAt, cutoff)))
        .limit(CLEANUP_BATCH);
      const result = await this.database.db
        .delete(telegramUpdates)
        .where(and(eq(telegramUpdates.botIdentity, this.config.botIdentity), inArray(telegramUpdates.telegramUpdateId, batch)));
      return result.rowCount ?? 0;
    });
  }

  /** Reminders that stopped moving are the failure a user notices first and the operator last. */
  async alertOwnerOnQueueProblems(now: Date): Promise<void> {
    if (!this.config.ownerTelegramUserId) return;
    const queue = await this.reminderQueue.queueSummary(now).catch(() => null);
    if (!queue) return;
    const problems = [
      ...(queue.stalePending ? [`pending>10min=${queue.stalePending}`] : []),
      ...(queue.deadLettered ? [`dead_letter=${queue.deadLettered}`] : []),
      ...(queue.ambiguous ? [`ambiguous=${queue.ambiguous}`] : []),
    ];
    const signature = problems.join(" ");
    if (signature === this.lastAlertSignature) return;
    this.lastAlertSignature = signature;
    if (!problems.length) return;
    logger.warn("reminder queue needs attention", { ...queue });
    await this.telegram.sendMessage(this.config.ownerTelegramUserId, t("ru", "ops_alert", { details: signature })).catch(() => undefined);
  }

  private async pingDeadManSwitch(): Promise<void> {
    if (!this.config.healthcheckPingUrl) return;
    try {
      const response = await fetch(this.config.healthcheckPingUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) logger.warn("healthcheck ping rejected", { status: response.status });
    } catch (error) {
      logger.warn("healthcheck ping failed", { error: safeError(error) });
    }
  }

  /** One grouped SUM for everyone, then a notice per user who crossed their threshold this month. */
  private async checkAiSpendWarnings(now: Date): Promise<void> {
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rows = await this.database.db
      .select({ user: users, settings: userSettings })
      .from(users)
      .innerJoin(userSettings, eq(userSettings.userId, users.id))
      .where(and(eq(users.status, "active"), or(isNull(userSettings.lastAiSpendWarningMonth), ne(userSettings.lastAiSpendWarningMonth, month))));
    if (!rows.length) return;
    const spendByUser = await this.ai.monthlySpendByUser(monthStart);
    for (const row of rows) {
      const userThreshold = Number(row.settings.aiMonthlyWarningUsd);
      const threshold = Number.isFinite(userThreshold) && userThreshold > 0 ? userThreshold : (this.config.aiMonthlyWarningUsd ?? 0);
      if (threshold <= 0) continue;
      const spend = spendByUser.get(row.user.id) ?? 0;
      if (spend < threshold) continue;
      const marked = await this.settings.markSpendWarning(row.user.id, month);
      if (!marked) continue;
      const amount = spend.toFixed(2);
      const locale = interfaceLocale(row.settings.pinnedLanguage);
      await this.telegram.sendMessage(row.user.telegramUserId, t(locale, "ai_spend_warning", { amount })).catch(() => undefined);
      if (this.config.ownerTelegramUserId && this.config.ownerTelegramUserId !== row.user.telegramUserId) {
        await this.telegram.sendMessage(this.config.ownerTelegramUserId, t("ru", "ai_spend_owner_notice", { userId: row.user.id, amount })).catch(() => undefined);
      }
    }
  }
}
