import { InlineKeyboard } from "grammy";
import type { ChatProcessResult } from "../chat/chat.service.js";
import { compactText } from "../core/telegram-ux.js";

export type RenderedChatResult = { responseText: string; persistedText: string; keyboard: InlineKeyboard | undefined };

/** Telegram limits a message to 4096 characters; the cap leaves room for the review header. */
export const MAX_REPLY_LENGTH = 3_900;

/**
 * One rendering for every path that delivers a chat result (the interactive reply and the
 * automatic retry), so both cap the prose, keep the report intact and carry the same buttons.
 */
export function renderChatResult(result: Extract<ChatProcessResult, { kind: "ok" }>): RenderedChatResult {
  const suffix = actionSummary(result.pendingCount, result.pendingTitles, result.appliedCount);
  const warningText = result.warnings.length ? `\n\n${result.warnings.join("\n")}` : "";
  // Only the model's prose is capped; the deterministic report must stay complete.
  const body = compactText(result.text, result.review ? 800 : 600);
  const reportText = result.report ? `\n\n${result.report}` : "";
  const persistedText = compactText(`${body}${reportText}${suffix ? `\n\n${suffix}` : ""}${warningText}`, MAX_REPLY_LENGTH);
  const header = reviewHeader(result.review);
  const responseText = header ? `${header}\n\n${persistedText}` : persistedText;
  const keyboard = chatResultKeyboard(result.appliedGroupId, result.pendingGroupId, result.checkpointTopicId, result.topicId, result.review);
  return { responseText, persistedText, keyboard };
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

export function actionSummary(pendingCount: number, pendingTitles: readonly string[] = [], appliedCount = 0): string {
  if (!pendingCount) return "";
  // The model often narrates a proposal in the past tense ("Отменил."). When nothing was
  // actually stored, the summary has to say so plainly, in the same message.
  const nothingApplied = appliedCount === 0;
  const titles = pendingTitles.filter((title) => title.trim()).slice(0, 8);
  const headerOne = nothingApplied ? "⏳ Пока ничего не изменил — нужно подтверждение" : "⏳ Нужно подтверждение";
  const headerMany = nothingApplied ? `⏳ Пока ничего не изменил — нужно подтвердить (${pendingCount})` : `⏳ Нужно подтвердить (${pendingCount})`;
  if (!titles.length) return `${pendingCount === 1 ? headerOne : headerMany}.`;
  const lines = [`${pendingCount === 1 ? headerOne : headerMany}:`, ...titles.map((title) => `• ${title}`)];
  if (pendingCount > titles.length) lines.push(`• … ещё ${pendingCount - titles.length}`);
  return lines.join("\n");
}
