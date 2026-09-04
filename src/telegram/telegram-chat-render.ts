import { InlineKeyboard } from "grammy";
import type { ChatProcessResult } from "../chat/chat.service.js";
import { MODEL_REPLY_MAX, REVIEW_REPLY_MAX, compactText } from "../core/telegram-ux.js";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";

export type RenderedChatResult = { responseText: string; persistedText: string; keyboard: InlineKeyboard | undefined };

/** Telegram limits a message to 4096 characters; the cap leaves room for the review header. */
export const MAX_REPLY_LENGTH = 3_900;

/**
 * One rendering for every path that delivers a chat result (the interactive reply and the
 * automatic retry), so both cap the prose, keep the report intact and carry the same buttons.
 */
export function renderChatResult(result: Extract<ChatProcessResult, { kind: "ok" }>, locale: TelegramLocale = "ru"): RenderedChatResult {
  const suffix = actionSummary(result.pendingCount, result.pendingTitles, result.appliedCount, locale);
  const warningText = result.warnings.length ? `\n\n${result.warnings.join("\n")}` : "";
  // Only the model's prose is capped; the deterministic report must stay complete.
  const body = compactText(result.text, result.review ? REVIEW_REPLY_MAX : MODEL_REPLY_MAX);
  const reportText = result.report ? `\n\n${result.report}` : "";
  const persistedText = compactText(`${body}${reportText}${suffix ? `\n\n${suffix}` : ""}${warningText}`, MAX_REPLY_LENGTH);
  const header = reviewHeader(result.review, locale);
  const responseText = header ? `${header}\n\n${persistedText}` : persistedText;
  const keyboard = chatResultKeyboard(result.appliedGroupId, result.pendingGroupId, result.checkpointTopicId, result.topicId, result.review, locale);
  return { responseText, persistedText, keyboard };
}

export function chatResultKeyboard(
  appliedGroupId?: string,
  pendingGroupId?: string,
  checkpointTopicId?: string,
  topicId?: string,
  review?: { kind: "evening" | "weekly"; step?: number; totalSteps?: number; completed: boolean },
  locale: TelegramLocale = "ru",
): InlineKeyboard | undefined {
  const activeReview = review && !review.completed && topicId;
  if (!appliedGroupId && !pendingGroupId && !activeReview) return undefined;
  const keyboard = new InlineKeyboard();
  let hasRow = false;
  if (pendingGroupId) {
    keyboard.text(t(locale, "confirm_button"), `act:confirm:${pendingGroupId}`).text(t(locale, "decline_button"), `act:cancel:${pendingGroupId}`);
    hasRow = true;
  }
  if (appliedGroupId) {
    if (hasRow) keyboard.row();
    keyboard.text(t(locale, "undo_button"), `act:undo:${appliedGroupId}`);
    hasRow = true;
  }
  if (activeReview) {
    if (hasRow) keyboard.row();
    keyboard.text(t(locale, review.kind === "weekly" ? "review_end_weekly_button" : "review_end_evening_button"), `topic:end:${topicId}`);
  }
  return keyboard;
}

function reviewHeader(review: { kind: "evening" | "weekly"; step?: number; totalSteps?: number; completed: boolean } | undefined, locale: TelegramLocale): string {
  if (!review) return "";
  const title = t(locale, review.kind === "weekly" ? "review_header_weekly" : "review_header_evening");
  if (review.completed) return `${title} · ${t(locale, "review_header_done")}`;
  return `${title} · ${review.step ?? 1}/${review.totalSteps ?? 3}`;
}

const SUMMARY_COPY: Record<TelegramLocale, { nothingOne: string; nothingMany: string; one: string; many: string; more: string }> = {
  ru: { nothingOne: "⏳ Пока ничего не изменил — нужно подтверждение", nothingMany: "⏳ Пока ничего не изменил — нужно подтвердить ({n})", one: "⏳ Нужно подтверждение", many: "⏳ Нужно подтвердить ({n})", more: "• … ещё {n}" },
  uk: { nothingOne: "⏳ Поки нічого не змінив — потрібне підтвердження", nothingMany: "⏳ Поки нічого не змінив — потрібно підтвердити ({n})", one: "⏳ Потрібне підтвердження", many: "⏳ Потрібно підтвердити ({n})", more: "• … ще {n}" },
  en: { nothingOne: "⏳ Nothing changed yet — needs your confirmation", nothingMany: "⏳ Nothing changed yet — {n} changes need your confirmation", one: "⏳ Needs confirmation", many: "⏳ {n} changes need confirmation", more: "• … {n} more" },
};

export function actionSummary(pendingCount: number, pendingTitles: readonly string[] = [], appliedCount = 0, locale: TelegramLocale = "ru"): string {
  if (!pendingCount) return "";
  // The model often narrates a proposal in the past tense ("Отменил."). When nothing was
  // actually stored, the summary has to say so plainly, in the same message.
  const copy = SUMMARY_COPY[locale];
  const nothingApplied = appliedCount === 0;
  const titles = pendingTitles.filter((title) => title.trim()).slice(0, 8);
  const header = (pendingCount === 1 ? (nothingApplied ? copy.nothingOne : copy.one) : (nothingApplied ? copy.nothingMany : copy.many)).replace("{n}", String(pendingCount));
  if (!titles.length) return `${header}.`;
  const lines = [`${header}:`, ...titles.map((title) => `• ${title}`)];
  if (pendingCount > titles.length) lines.push(copy.more.replace("{n}", String(pendingCount - titles.length)));
  return lines.join("\n");
}
