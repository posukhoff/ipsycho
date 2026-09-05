import { compactText } from "../core/telegram-ux.js";
import { occurrenceLocalDate } from "../core/local-schedule.js";
import { recurrenceLabel } from "../core/recurrence-label.js";
import { localDateAt } from "../core/timezone.js";
import { plural, pluralForm, t } from "./copy/index.js";
import { formatLocalDateTime, intlLocale } from "../core/time-presentation.js";
import { selectCardDetails } from "../core/card-details.js";
import type { TelegramLocale } from "./telegram-locale.js";

/**
 * The vocabulary every Telegram view shares: what a card knows about a task and an occurrence,
 * and the small formatters that turn those fields into one localized line.
 */
export type TelegramImportance = "normal" | "required" | "critical";

export type TelegramOccurrenceStatus = "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";

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

export type TelegramTaskListRow = { task: TelegramTaskCard & { id: string }; occurrence: TelegramOccurrenceCard | null };

/** What a list screen needs from one collapsed group; the grouping itself lives in `src/core/task-list-view.ts`. */
export interface TelegramGroupCard {
  key: string;
  title: string;
  importance: TelegramImportance;
  recurrenceRule: string | null;
  rows: ReadonlyArray<TelegramTaskListRow>;
  lead: TelegramTaskListRow;
  pastCount: number;
}

export const CARD_COPY = {
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

export function occurrenceWhen(occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale = "ru"): string {
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

/**
 * Whether a line says «просрочено». Two answers used to disagree: the line read the maintained
 * `overdue` flag, while the list's own «просрочено раньше» count read the local date, so a task
 * whose day had passed could be counted and yet look untouched until the minute loop caught up.
 * The date decides for an earlier day, the flag for today.
 */
export function isOverdueForDisplay(occurrence: TelegramOccurrenceCard, now: Date): boolean {
  if (occurrence.overdue) return true;
  const localDate = occurrenceLocalDate(occurrence);
  return Boolean(localDate && localDate < localDateAt(now, occurrence.timezone));
}

/** The one word a list line uses for it. */
export function overdueMark(occurrence: TelegramOccurrenceCard, now: Date, locale: TelegramLocale): string {
  return isOverdueForDisplay(occurrence, now) ? t(locale, "scope_overdue") : "";
}

export function reminderTimeLabel(reminderAt: Date, occurrence: TelegramOccurrenceCard, now: Date, locale: CardLocale): string {
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

/** Compact "when" for list screens: exact time, deadline, date or fuzzy horizon. */
export function overviewWhen(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard | null, now: Date, locale: TelegramLocale = "ru"): string {
  if (!occurrence) return task.fuzzyHorizonText ? ` · 🫧 ${task.fuzzyHorizonText}` : "";
  const when = occurrenceWhen(occurrence, now, locale);
  return when ? ` · ${when}` : "";
}

/**
 * The "when" of a collapsed group. A group holds everything that reads as one thing, so the line
 * must say how much is hidden behind it: a repeating rule, several times in one day, or several
 * dates. Only the nearest one gets a full timestamp — the rest is a count the user can open.
 */
export function groupWhenLabel(group: TelegramGroupCard, now: Date, locale: TelegramLocale = "ru"): string {
  const { lead, rows } = group;
  if (rows.length < 2) return overviewWhen(lead.task, lead.occurrence, now, locale);
  const dates = distinctLocalDates(rows);
  const next = lead.occurrence ? occurrenceWhen(lead.occurrence, now, locale) : lead.task.fuzzyHorizonText ? `🫧 ${lead.task.fuzzyHorizonText}` : "";
  const rule = group.recurrenceRule ? recurrenceLabel(group.recurrenceRule, lead.task.recurrenceEndLocalDate ?? null, locale) : "";
  // Several times on one day read better as the times themselves than as "2 dates".
  const sameDayTimes = dates.length === 1 ? sameDayTimeList(rows, locale) : null;
  const detail = sameDayTimes ?? [dates.length > 1 ? plural(locale, dates.length, "date") : "", next ? `${t(locale, "group_next")} ${next}` : ""].filter(Boolean).join(" · ");
  const parts = [rule, detail].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function sameDayTimeList(rows: ReadonlyArray<TelegramTaskListRow>, locale: TelegramLocale): string | null {
  const times = rows.map((row) => (row.occurrence?.plannedStartAt ? formatTime(new Date(row.occurrence.plannedStartAt), row.occurrence.timezone, locale) : null));
  return times.every((time): time is string => time !== null) ? times.join(", ") : null;
}

function distinctLocalDates(rows: ReadonlyArray<TelegramTaskListRow>): string[] {
  const dates: string[] = [];
  for (const { occurrence } of rows) {
    if (!occurrence) continue;
    const localDate = occurrenceLocalDate(occurrence);
    if (localDate && !dates.includes(localDate)) dates.push(localDate);
  }
  return dates;
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

export function formatLocal(at: Date, timezone: string): string {
  return formatLocalDateTime(at, timezone, new Date());
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

export function taskWord(count: number, locale: TelegramLocale = "ru"): string {
  return pluralForm(locale, count, "deed");
}

export function messageWord(count: number, locale: TelegramLocale = "ru"): string {
  if (locale === "en") return count === 1 ? "message" : "messages";
  if (locale === "uk") return count === 1 ? "повідомлення" : count >= 2 && count <= 4 ? "повідомлення" : "повідомлень";
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "сообщений";
  if (mod10 === 1) return "сообщение";
  if (mod10 >= 2 && mod10 <= 4) return "сообщения";
  return "сообщений";
}

export function quietHoursLabel(
  row: { quietHoursEnabled: boolean; weekdayQuietStart: string; weekdayQuietEnd: string; weekendQuietStart?: string | null; weekendQuietEnd?: string | null },
  locale: TelegramLocale,
): string {
  if (!row.quietHoursEnabled) return locale === "en" ? "off" : locale === "uk" ? "вимкнено" : "выкл";
  const weekday = `${row.weekdayQuietStart}–${row.weekdayQuietEnd}`;
  const weekend = row.weekendQuietStart && row.weekendQuietEnd ? `${row.weekendQuietStart}–${row.weekendQuietEnd}` : null;
  if (!weekend || weekend === weekday) return weekday;
  return locale === "en"
    ? `${weekday} (weekdays), ${weekend} (weekends)`
    : locale === "uk"
      ? `${weekday} (будні), ${weekend} (вихідні)`
      : `${weekday} (будни), ${weekend} (выходные)`;
}

export function weekdayLabel(value: number, locale: TelegramLocale): string {
  const labels =
    locale === "en"
      ? ["?", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : locale === "uk"
        ? ["?", "пн", "вт", "ср", "чт", "пт", "сб", "нд"]
        : ["?", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  return labels[value] ?? String(value);
}

/** Which code is answering: the deploy pipeline checks out one exact commit, so its short SHA identifies the build. */
