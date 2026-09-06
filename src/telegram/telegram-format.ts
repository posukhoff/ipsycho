import { compactText } from "../core/telegram-ux.js";
import { isOverdueForDisplay } from "../core/local-schedule.js";
import { localDateAt } from "../core/timezone.js";
import { t } from "./copy/index.js";
import { formatLocalDateTime, intlLocale } from "../core/time-presentation.js";
import { selectCardDetails } from "../core/card-details.js";
import type { TelegramLocale } from "./telegram-locale.js";

/**
 * The vocabulary every Telegram card shares: what a card knows about a task and an occurrence, and
 * the small formatters that turn those fields into one localized line.
 *
 * It used to serve the list screens too — group labels, weekday names, plural task counts, the
 * settings summary. Those moved to the Mini App with the screens themselves (task 11), so what is
 * left is only what a card, a reminder and the morning card's one-line-per-task body still need.
 */
type TelegramImportance = "normal" | "required" | "critical";

type TelegramOccurrenceStatus = "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";

export interface TelegramTaskCard {
  title: string;
  importance: TelegramImportance;
  kind?: "task" | "event";
  recurrenceRule?: string | null;
  recurrenceEndLocalDate?: string | null;
  /** Dates the series skips; the rhythm line names them so it does not describe a series the user lacks. */
  recurrenceExcludedLocalDates?: readonly string[] | null;
  fuzzyHorizonText?: string | null;
  reviewAt?: Date | string | null;
  timezone: string;
  /** Optional detail fields; a card shows only those that are present. */
  why?: string | null;
  nextAction?: string | null;
  context?: string | null;
  checklist?: ReadonlyArray<{ text: string; done: boolean }> | null;
  goalTitle?: string | null;
  nextReminderAt?: Date | string | null;
}

export interface TelegramOccurrenceCard {
  id: string;
  status: TelegramOccurrenceStatus;
  timezone: string;
  plannedStartAt?: Date | string | null;
  plannedEndAt?: Date | string | null;
  plannedLocalDate?: string | null;
  dueAt?: Date | string | null;
  dueLocalDate?: string | null;
  overdue?: boolean;
  completedAt?: Date | string | null;
}

const CARD_COPY = {
  ru: {
    inProgress: "▶️ В работе",
    overdue: "⚠️ Просрочено",
    noDate: "🫧 Без точной даты",
    comeBack: "🗓 Вернуться:",
    planningReview: "Пора решить, когда вернуться к задаче.",
    howGoing: "Как идёт?",
    why: "💡 Зачем:",
    nextStep: "➡️ Следующий шаг:",
    checklist: "☑️ Чеклист",
    more: "… ещё",
    goal: "🎯 Цель:",
    by: "до",
    overdueShort: "⚠️ просрочено",
    now: "сейчас",
    in: "через",
    min: "мин",
    h: "ч",
    d: "дн",
    forWord: "на",
  },
  uk: {
    inProgress: "▶️ У роботі",
    overdue: "⚠️ Прострочено",
    noDate: "🫧 Без точної дати",
    comeBack: "🗓 Повернутися:",
    planningReview: "Час вирішити, коли повернутися до завдання.",
    howGoing: "Як іде?",
    why: "💡 Навіщо:",
    nextStep: "➡️ Наступний крок:",
    checklist: "☑️ Чекліст",
    more: "… ще",
    goal: "🎯 Ціль:",
    by: "до",
    overdueShort: "⚠️ прострочено",
    now: "зараз",
    in: "через",
    min: "хв",
    h: "год",
    d: "дн",
    forWord: "на",
  },
  en: {
    inProgress: "▶️ In progress",
    overdue: "⚠️ Overdue",
    noDate: "🫧 No exact date",
    comeBack: "🗓 Come back:",
    planningReview: "Time to decide when to return to this task.",
    howGoing: "How is it going?",
    why: "💡 Why:",
    nextStep: "➡️ Next step:",
    checklist: "☑️ Checklist",
    more: "… more",
    goal: "🎯 Goal:",
    by: "by",
    overdueShort: "⚠️ overdue",
    now: "now",
    in: "in",
    min: "min",
    h: "h",
    d: "d",
    forWord: "by",
  },
} as const;

export type CardLocale = TelegramLocale;

export function cardCopy(locale: CardLocale) {
  return CARD_COPY[locale];
}

/** One line with the persisted time of an occurrence: start(–end) / deadline / date, plus the next reminder. */
export function scheduleLine(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard, now: Date, relative = "", locale: CardLocale = "ru"): string {
  const when = occurrenceWhen(occurrence, now, locale);
  if (!when) return "";
  const reminder = task.nextReminderAt ? ` · 🔔 ${reminderTimeLabel(new Date(task.nextReminderAt), occurrence, now, locale)}` : "";
  const suffix = relative ? ` · ${relative}` : "";
  return `📅 ${when} (${occurrence.timezone})${reminder}${suffix}`;
}

function occurrenceWhen(occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale = "ru"): string {
  const tz = occurrence.timezone;
  const tag = intlLocale(locale);
  const by = cardCopy(locale).by;
  if (occurrence.plannedStartAt && occurrence.plannedEndAt) {
    const start = new Date(occurrence.plannedStartAt);
    const end = new Date(occurrence.plannedEndAt);
    const endLabel = localDateAt(start, tz) === localDateAt(end, tz) ? formatTime(end, tz, locale) : formatLocalDateTime(end, tz, now, tag);
    return `${formatLocalDateTime(start, tz, now, tag)}–${endLabel}`;
  }
  if (occurrence.plannedStartAt) return formatLocalDateTime(new Date(occurrence.plannedStartAt), tz, now, tag);
  if (occurrence.dueAt) return `${by} ${formatLocalDateTime(new Date(occurrence.dueAt), tz, now, tag)}`;
  if (occurrence.plannedLocalDate) return formatDateLabel(occurrence.plannedLocalDate, tz, now);
  if (occurrence.dueLocalDate) return `${by} ${formatDateLabel(occurrence.dueLocalDate, tz, now)}`;
  return "";
}

/** The one word a list line uses for it. */
export function overdueMark(occurrence: TelegramOccurrenceCard, now: Date, locale: TelegramLocale): string {
  return isOverdueForDisplay(occurrence, now) ? t(locale, "scope_overdue") : "";
}

function reminderTimeLabel(reminderAt: Date, occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale): string {
  const anchor = occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : occurrence.dueAt ? new Date(occurrence.dueAt) : null;
  if (anchor && localDateAt(anchor, occurrence.timezone) === localDateAt(reminderAt, occurrence.timezone)) return formatTime(reminderAt, occurrence.timezone, locale);
  return formatLocalDateTime(reminderAt, occurrence.timezone, now, intlLocale(locale));
}

export function overdueFor(occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale): string {
  const copy = cardCopy(locale);
  const target = occurrence.dueAt ? new Date(occurrence.dueAt) : occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : null;
  if (!target) return "";
  const minutes = Math.round((now.getTime() - target.getTime()) / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return ` ${copy.forWord} ${minutes} ${copy.min}`;
  if (minutes < 48 * 60) return ` ${copy.forWord} ${Math.round(minutes / 60)} ${copy.h}`;
  return ` ${copy.forWord} ${Math.round(minutes / (24 * 60))} ${copy.d}`;
}

/** Detail lines in reading order; fields that only repeat the title, goal or checklist are dropped (see selectCardDetails). */
export function detailLines(task: TelegramTaskCard, locale: CardLocale): string[] {
  const copy = cardCopy(locale);
  const lines: string[] = [];
  const details = selectCardDetails(task);
  if (details.why) lines.push(`${copy.why} ${compactText(details.why, 300)}`);
  if (details.nextAction) lines.push(`${copy.nextStep} ${compactText(details.nextAction, 300)}`);
  if (details.context) lines.push(`📝 ${compactText(details.context, 400)}`);
  lines.push(...checklistLines(task.checklist, 12, locale));
  if (task.goalTitle?.trim()) lines.push(`${copy.goal} «${task.goalTitle.trim()}»`);
  return lines;
}

export function checklistLines(checklist: TelegramTaskCard["checklist"], limit: number, locale: CardLocale): string[] {
  if (!checklist?.length) return [];
  const copy = cardCopy(locale);
  const done = checklist.filter((item) => item.done).length;
  const lines = [`${copy.checklist} ${done}/${checklist.length}`];
  for (const item of checklist.slice(0, limit)) lines.push(`${item.done ? "✅" : "◻️"} ${compactText(item.text, 120)}`);
  if (checklist.length > limit) lines.push(`${copy.more} ${checklist.length - limit}`);
  return lines;
}

export function relativeDue(occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale): string {
  const copy = cardCopy(locale);
  const target = occurrence.dueAt ? new Date(occurrence.dueAt) : occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : null;
  if (!target) return occurrence.overdue ? copy.overdueShort : "";
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < -1) return `${copy.overdueShort}${overdueFor(occurrence, now, locale)}`;
  if (minutes <= 1) return copy.now;
  if (minutes < 60) return `${copy.in} ${minutes} ${copy.min}`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest && hours < 6 ? `${copy.in} ${hours} ${copy.h} ${rest} ${copy.min}` : `${copy.in} ${Math.round(minutes / 60)} ${copy.h}`;
  }
  return `${copy.in} ${Math.round(minutes / (24 * 60))} ${copy.d}`;
}

export function importanceIcon(importance: TelegramImportance): string {
  return importance === "critical" ? "🔴" : importance === "required" ? "🟡" : "";
}

export function formatTime(at: Date, timezone: string, locale: CardLocale = "ru"): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(at);
}

export function formatDateLabel(value: string, timezone?: string, now?: Date): string {
  const [year, month, day] = value.split("-");
  if (!(day && month && year)) return value;
  const currentYear = now && timezone ? localDateAt(now, timezone).slice(0, 4) : year;
  return currentYear === year ? `${day}.${month}` : `${day}.${month}.${year}`;
}
