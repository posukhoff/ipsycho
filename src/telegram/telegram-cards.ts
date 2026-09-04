import { compactText } from "../core/telegram-ux.js";
import { selectCardDetails } from "../core/card-details.js";
import { recurrenceLabel } from "../core/recurrence-label.js";
import { localDateAt } from "../core/timezone.js";
import { formatLocalDateTime, intlLocale } from "../core/time-presentation.js";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import {
  cardCopy,
  checklistLines,
  detailLines,
  formatDateLabel,
  formatTime,
  importanceIcon,
  overdueFor,
  relativeDue,
  scheduleLine,
  type CardLocale,
  type TelegramOccurrenceCard,
  type TelegramTaskCard,
} from "./telegram-format.js";

/** One task, one reminder, one finished item: the message bodies the user actually reads. */
export function taskCardText(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard, now: Date = new Date(), locale: CardLocale = "ru"): string {
  const copy = cardCopy(locale);
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const head = [title];
  const when = scheduleLine(task, occurrence, now, "", locale);
  if (when) head.push(when);
  const recurrence = recurrenceLabel(task.recurrenceRule, task.recurrenceEndLocalDate, locale);
  if (recurrence) head.push(`🔁 ${recurrence}`);
  const state = occurrence.status === "in_progress" ? copy.inProgress : occurrence.overdue ? `${copy.overdue}${overdueFor(occurrence, now, locale)}` : "";
  if (state) head.push(state);
  const details = detailLines(task, locale);
  return details.length ? `${head.join("\n")}\n\n${details.join("\n")}` : head.join("\n");
}

export function fuzzyTaskCardText(task: TelegramTaskCard, now: Date = new Date(), locale: CardLocale = "ru"): string {
  const copy = cardCopy(locale);
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const horizon = task.fuzzyHorizonText ? `🫧 ${task.fuzzyHorizonText}` : copy.noDate;
  const review = task.reviewAt ? `${copy.comeBack} ${formatLocalDateTime(new Date(task.reviewAt), task.timezone, now, intlLocale(locale))} (${task.timezone})` : "";
  const head = [title, horizon, review].filter(Boolean);
  const details = detailLines(task, locale);
  return details.length ? `${head.join("\n")}\n\n${details.join("\n")}` : head.join("\n");
}

export function reminderCardText(input: {
  task: TelegramTaskCard;
  occurrence?: TelegramOccurrenceCard | null;
  purpose: "user_reminder" | "planning_review" | "follow_up";
  now: Date;
  locale?: CardLocale;
  /** A line above the card: "was in quiet hours", "3rd reminder since the deadline". */
  header?: string | null;
}): string {
  const locale = input.locale ?? "ru";
  const copy = cardCopy(locale);
  const icon = input.purpose === "planning_review" ? "🗓" : input.purpose === "follow_up" ? "↩️" : "🔔";
  const title = `${icon} ${importanceIcon(input.task.importance)} ${input.task.title}`.replace(/\s+/g, " ").trim();
  const prompt = input.purpose === "planning_review" ? copy.planningReview : input.purpose === "follow_up" && input.occurrence?.status === "in_progress" ? copy.howGoing : "";
  const lines = input.header ? [input.header, title] : [title];
  if (input.occurrence) {
    const when = scheduleLine(input.task, input.occurrence, input.now, relativeDue(input.occurrence, input.now, locale), locale);
    if (when) lines.push(when);
  } else if (input.task.fuzzyHorizonText) {
    lines.push(`🫧 ${input.task.fuzzyHorizonText}`);
  }
  const recurrence = recurrenceLabel(input.task.recurrenceRule, input.task.recurrenceEndLocalDate, locale);
  if (recurrence) lines.push(`🔁 ${recurrence}`);
  // At the moment of the reminder the next concrete step matters more than the rationale.
  const details = selectCardDetails(input.task);
  if (details.nextAction) lines.push(`➡️ ${compactText(details.nextAction, 300)}`);
  if (details.context) lines.push(`📝 ${compactText(details.context, 200)}`);
  const checklist = checklistLines(input.task.checklist, 3, locale);
  if (checklist.length) lines.push(...checklist);
  if (prompt) lines.push("", prompt);
  return lines.join("\n").trimEnd();
}

/** One line with the persisted time of an occurrence: start(–end) / deadline / date, plus the next reminder. */

export function terminalTaskText(task: TelegramTaskCard, status: "done" | "skipped" | "cancelled", now: Date, locale: TelegramLocale = "ru"): string {
  if (status === "done") return `✅ ${task.title}\n${t(locale, "done_toast")} · ${formatTime(now, task.timezone)}`;
  if (status === "skipped") return `⏭ ${task.title}\n${t(locale, "skipped_toast")}`;
  return `❌ ${task.title}\n${t(locale, "cancelled_occurrence_toast")}`;
}

export function todayLine(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard | null, localDate: string, locale: TelegramLocale, now: Date = new Date()): string {
  const icon = importanceIcon(task.importance) || (task.recurrenceRule ? "🔁" : "•");
  if (!occurrence) {
    const fuzzyIcon = importanceIcon(task.importance) || "🫧";
    const review = task.reviewAt
      ? ` · ${locale === "en" ? "review at" : locale === "uk" ? "переглянути о" : "пересмотреть в"} ${formatTime(new Date(task.reviewAt), task.timezone, locale)}`
      : "";
    return `${fuzzyIcon} ${task.title}${review}`;
  }
  const tz = occurrence.timezone;
  const sameDay = (value: Date | string | null | undefined) => Boolean(value) && localDateAt(new Date(value!), tz) === localDate;
  let when = "";
  if (occurrence.plannedStartAt && occurrence.plannedEndAt && sameDay(occurrence.plannedStartAt))
    when = `${formatTime(new Date(occurrence.plannedStartAt), tz, locale)}–${formatTime(new Date(occurrence.plannedEndAt), tz, locale)}`;
  else if (occurrence.plannedStartAt && sameDay(occurrence.plannedStartAt)) when = formatTime(new Date(occurrence.plannedStartAt), tz, locale);
  else if (occurrence.dueAt && sameDay(occurrence.dueAt)) when = `${locale === "en" ? "by" : "до"} ${formatTime(new Date(occurrence.dueAt), tz, locale)}`;
  else if (occurrence.plannedStartAt || occurrence.dueAt) when = formatLocalDateTime(new Date((occurrence.plannedStartAt ?? occurrence.dueAt)!), tz, now, intlLocale(locale));
  else if (occurrence.dueLocalDate && occurrence.dueLocalDate !== localDate) when = `${locale === "en" ? "by" : "до"} ${formatDateLabel(occurrence.dueLocalDate, tz, now)}`;
  const state = occurrence.overdue
    ? locale === "en"
      ? "overdue"
      : locale === "uk"
        ? "прострочено"
        : "просрочено"
    : occurrence.status === "in_progress"
      ? locale === "en"
        ? "in progress"
        : locale === "uk"
          ? "у роботі"
          : "в работе"
      : "";
  const parts = [when, state].filter(Boolean);
  return `${icon} ${task.title}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** Compact "when" for list screens: exact time, deadline, date or fuzzy horizon. */

/** Which code is answering: the deploy pipeline checks out one exact commit, so its short SHA identifies the build. */
export function deployedBuildLine(commit: string | undefined, locale: TelegramLocale): string {
  const label = commit ? commit.slice(0, 7) : null;
  if (locale === "uk") return label ? `🏷 Збірка: ${label}` : "🏷 Збірка: невідома (APP_COMMIT не заданий)";
  if (locale === "en") return label ? `🏷 Build: ${label}` : "🏷 Build: unknown (APP_COMMIT is not set)";
  return label ? `🏷 Сборка: ${label}` : "🏷 Сборка: неизвестна (APP_COMMIT не задан)";
}
