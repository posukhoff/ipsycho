import { Inject, Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { ChatService, type ChatProcessResult } from "../chat/chat.service.js";
import { compactText } from "../core/telegram-ux.js";
import { safeError } from "../observability/safe-error.js";

export type ActiveAccess = NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>;

@Injectable()
export class TelegramChatReplyService {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  async reply(ctx: any, access: ActiveAccess, result: ChatProcessResult): Promise<void> {
    if (result.kind === "duplicate") return;
    if (result.kind === "nothing_to_retry") return void await ctx.reply("Нет сохранённых сообщений, которые ждут AI-обработки.");
    if (result.kind === "ai_suspended") return void await ctx.reply("AI-обработка для аккаунта приостановлена. Напоминания и кнопки продолжают работать.");
    if (result.kind === "ai_unavailable") return void await ctx.reply("AI сейчас не настроен или временно недоступен. Попробуй позже.");
    if (result.kind === "rate_limited") return void await ctx.reply("Слишком много AI-запросов за последний час. Попробуй позже; обычные напоминания продолжают работать.");
    if (result.kind === "consent_required") {
      await ctx.reply(`Для AI-чата текст сообщений будет отправляться внешнему провайдеру ${result.provider}. Голосовые при OpenAI отправляются только для расшифровки и не сохраняются как аудио. Разрешить такую обработку?`, {
        reply_markup: new InlineKeyboard().text("Согласен", "ai:consent").text("Не сейчас", "ai:decline"),
      });
      return;
    }

    const suffix = actionSummary(result.pendingCount, result.pendingTitles);
    const warningText = result.warnings.length ? `\n\n${result.warnings.join("\n")}` : "";
    // Only the model's prose is capped; the deterministic report must stay complete.
    const body = compactText(result.text, result.review ? 800 : 600);
    const reportText = result.report ? `\n\n${result.report}` : "";
    const persistedText = compactText(`${body}${reportText}${suffix ? `\n\n${suffix}` : ""}${warningText}`, 3_900);
    const header = reviewHeader(result.review);
    const responseText = header ? `${header}\n\n${persistedText}` : persistedText;
    const keyboard = chatResultKeyboard(result.appliedGroupId, result.pendingGroupId, result.checkpointTopicId, result.topicId, result.review);
    try {
      const sent = await ctx.reply(responseText, keyboard ? { reply_markup: keyboard } : {});
      if (result.skipAssistantHistory) return;
      await this.chat.recordAssistantMessage({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        content: persistedText,
        telegramChatId: ctx.chat.id,
        telegramMessageId: sent.message_id,
        ...(result.topicId ? { topicId: result.topicId } : {}),
      }).catch((error) => console.error("assistant message persistence failed", { userId: access.user.id, error: safeError(error) }));
    } catch (error) {
      console.error("telegram reply failed after processing", { userId: access.user.id, error: safeError(error) });
    }
  }
}

export function chatResultKeyboard(
  appliedGroupId?: string,
  pendingGroupId?: string,
  checkpointTopicId?: string,
  topicId?: string,
  review?: { kind: "evening" | "weekly"; step?: number; totalSteps?: number; completed: boolean },
): InlineKeyboard | undefined {
  const activeReview = review && !review.completed && topicId;
  if (!appliedGroupId && !pendingGroupId && !activeReview) return undefined;
  const keyboard = new InlineKeyboard();
  let hasRow = false;
  if (pendingGroupId) {
    keyboard.text("Подтвердить", `act:confirm:${pendingGroupId}`).text("Не делать", `act:cancel:${pendingGroupId}`);
    hasRow = true;
  }
  if (appliedGroupId) {
    if (hasRow) keyboard.row();
    keyboard.text("↩️ Отменить", `act:undo:${appliedGroupId}`);
    hasRow = true;
  }
  if (activeReview) {
    if (hasRow) keyboard.row();
    keyboard.text(review.kind === "weekly" ? "Закончить планирование" : "Закончить разбор", `topic:end:${topicId}`);
  }
  return keyboard;
}

function reviewHeader(review?: { kind: "evening" | "weekly"; step?: number; totalSteps?: number; completed: boolean }): string {
  if (!review) return "";
  if (review.kind === "weekly") return review.completed ? "🗓 Планирование недели · готово" : `🗓 Планирование недели · ${review.step ?? 1}/${review.totalSteps ?? 3}`;
  if (review.completed) return "💭 Вечерний разбор · готово";
  return `💭 Вечерний разбор · ${review.step ?? 1}/${review.totalSteps ?? 3}`;
}

export function actionSummary(pendingCount: number, pendingTitles: readonly string[] = []): string {
  if (!pendingCount) return "";
  const titles = pendingTitles.filter((title) => title.trim()).slice(0, 8);
  if (!titles.length) return pendingCount === 1 ? "⏳ Нужно подтверждение." : `⏳ Нужно подтвердить: ${pendingCount}.`;
  const lines = [pendingCount === 1 ? "⏳ Нужно подтверждение:" : `⏳ Нужно подтвердить (${pendingCount}):`, ...titles.map((title) => `• ${title}`)];
  if (pendingCount > titles.length) lines.push(`• … ещё ${pendingCount - titles.length}`);
  return lines.join("\n");
}
