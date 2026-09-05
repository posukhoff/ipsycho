import { InlineKeyboard } from "grammy";
import type { ChatProcessResult } from "../chat/chat.service.js";
import { MODEL_REPLY_MAX, compactText } from "../core/telegram-ux.js";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";

export type RenderedChatResult = { persistedText: string; keyboard: InlineKeyboard | undefined };

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
  const body = compactText(result.text, MODEL_REPLY_MAX);
  const reportText = result.report ? `\n\n${result.report}` : "";
  const persistedText = compactText(`${body}${reportText}${suffix ? `\n\n${suffix}` : ""}${warningText}`, MAX_REPLY_LENGTH);
  const keyboard = chatResultKeyboard(result.appliedGroupId, result.pendingGroupId, locale);
  return { persistedText, keyboard };
}

export function chatResultKeyboard(appliedGroupId?: string, pendingGroupId?: string, locale: TelegramLocale = "ru"): InlineKeyboard | undefined {
  if (!appliedGroupId && !pendingGroupId) return undefined;
  const keyboard = new InlineKeyboard();
  let hasRow = false;
  if (pendingGroupId) {
    keyboard.text(t(locale, "confirm_button"), `act:confirm:${pendingGroupId}`).text(t(locale, "decline_button"), `act:cancel:${pendingGroupId}`);
    hasRow = true;
  }
  if (appliedGroupId) {
    if (hasRow) keyboard.row();
    keyboard.text(t(locale, "undo_button"), `act:undo:${appliedGroupId}`);
  }
  return keyboard;
}

const SUMMARY_COPY: Record<TelegramLocale, { nothingOne: string; nothingMany: string; one: string; many: string; more: string }> = {
  ru: {
    nothingOne: "⏳ Пока ничего не изменил — нужно подтверждение",
    nothingMany: "⏳ Пока ничего не изменил — нужно подтвердить ({n})",
    one: "⏳ Нужно подтверждение",
    many: "⏳ Нужно подтвердить ({n})",
    more: "• … ещё {n}",
  },
  uk: {
    nothingOne: "⏳ Поки нічого не змінив — потрібне підтвердження",
    nothingMany: "⏳ Поки нічого не змінив — потрібно підтвердити ({n})",
    one: "⏳ Потрібне підтвердження",
    many: "⏳ Потрібно підтвердити ({n})",
    more: "• … ще {n}",
  },
  en: {
    nothingOne: "⏳ Nothing changed yet — needs your confirmation",
    nothingMany: "⏳ Nothing changed yet — {n} changes need your confirmation",
    one: "⏳ Needs confirmation",
    many: "⏳ {n} changes need confirmation",
    more: "• … {n} more",
  },
};

export function actionSummary(pendingCount: number, pendingTitles: readonly string[] = [], appliedCount = 0, locale: TelegramLocale = "ru"): string {
  if (!pendingCount) return "";
  // The model often narrates a proposal in the past tense ("Отменил."). When nothing was
  // actually stored, the summary has to say so plainly, in the same message.
  const copy = SUMMARY_COPY[locale];
  const nothingApplied = appliedCount === 0;
  const titles = pendingTitles.filter((title) => title.trim()).slice(0, 8);
  const header = (pendingCount === 1 ? (nothingApplied ? copy.nothingOne : copy.one) : nothingApplied ? copy.nothingMany : copy.many).replace("{n}", String(pendingCount));
  if (!titles.length) return `${header}.`;
  const lines = [`${header}:`, ...titles.map((title) => `• ${title}`)];
  if (pendingCount > titles.length) lines.push(copy.more.replace("{n}", String(pendingCount - titles.length)));
  return lines.join("\n");
}
